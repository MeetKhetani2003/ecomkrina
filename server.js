import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import mysql from "mysql2/promise";

dotenv.config();

const app = express();

/* =========================
    MIDDLEWARE
========================= */

app.use(
  cors({
    origin: "http://localhost:5000",
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser());
app.use(express.static("./"));

/* =========================
    DATABASE
========================= */

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "ecomm",
  waitForConnections: true,
  connectionLimit: 10,
});

const initDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wishlist (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      product_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_product (user_id, product_id)
    )
  `);
};

initDatabase().catch((error) => {
  console.error("Failed to initialize database:", error.message);
});

/* =========================
    IMAGE UPLOAD
========================= */

const uploadDir = "./images";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

/* =========================
    AUTH MIDDLEWARE
========================= */

const authMiddleware = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: "Login required" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

/* =========================
        PRODUCTS
========================= */

// Get All
app.get("/api/products", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

// Get Single
app.get("/api/products/:id", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM products WHERE id=?", [
    req.params.id,
  ]);
  res.json(rows[0]);
});

// Add Product
app.post("/api/products", upload.single("image"), async (req, res) => {
  const { title, price, description, Rating } = req.body;
  const imagePath = req.file ? `images/${req.file.filename}` : null;

  const ratingValue = parseInt(Rating) || 0;

  if (ratingValue < 0 || ratingValue > 5)
    return res.status(400).json({ message: "Rating 0-5 only" });

  await pool.query(
    "INSERT INTO products (title, price, image, description, Rating) VALUES (?,?,?,?,?)",
    [title, price, imagePath, description, ratingValue],
  );

  res.json({ message: "Product added" });
});

// Update Product
app.put("/api/products/:id", async (req, res) => {
  const { title, price, description, Rating } = req.body;

  const ratingValue = parseInt(Rating);

  if (ratingValue < 0 || ratingValue > 5)
    return res.status(400).json({ message: "Rating 0-5 only" });

  await pool.query(
    "UPDATE products SET title=?, price=?, description=?, Rating=? WHERE id=?",
    [title, price, description, ratingValue, req.params.id],
  );

  res.json({ message: "Updated successfully" });
});

// ⭐ RATE PRODUCT (LOGIN REQUIRED)
app.put("/api/products/:id/rating", authMiddleware, async (req, res) => {
  const ratingValue = parseInt(req.body.Rating);

  if (!ratingValue || ratingValue < 1 || ratingValue > 5)
    return res.status(400).json({ message: "Rating must be 1-5" });

  await pool.query("UPDATE products SET Rating=? WHERE id=?", [
    ratingValue,
    req.params.id,
  ]);

  res.json({ message: "Rated successfully" });
});

// Delete
app.delete("/api/products/:id", async (req, res) => {
  const [rows] = await pool.query("SELECT image FROM products WHERE id=?", [
    req.params.id,
  ]);

  if (rows.length && rows[0].image && fs.existsSync(rows[0].image))
    fs.unlinkSync(rows[0].image);

  await pool.query("DELETE FROM products WHERE id=?", [req.params.id]);

  res.json({ message: "Deleted" });
});

/* =========================
        USERS
========================= */

app.post("/api/users/register", async (req, res) => {
  const { name, email, password } = req.body;

  await pool.query("INSERT INTO users (name,email,password) VALUES (?,?,?)", [
    name,
    email,
    password,
  ]);

  res.json({ message: "Registered" });
});

app.post("/api/users/login", async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE email=? AND password=?",
    [email, password],
  );

  if (!rows.length)
    return res.status(401).json({ message: "Invalid credentials" });

  const token = jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
  });

  res.json({
    message: "Login success",
    user: {
      id: rows[0].id,
      name: rows[0].name,
      email: rows[0].email,
    },
  });
});

app.get("/api/users/profile", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, name, email FROM users WHERE id = ?",
    [req.user.id],
  );

  if (!rows.length) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json(rows[0]);
});

/* =========================
        CART
========================= */

app.get("/api/cart", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `
    SELECT cart.id, products.title, products.price, products.image, cart.quantity
    FROM cart
    JOIN products ON cart.product_id = products.id
    WHERE cart.user_id=?
  `,
    [req.user.id],
  );

  res.json(rows);
});

app.post("/api/cart", authMiddleware, async (req, res) => {
  const { product_id, quantity } = req.body;

  await pool.query(
    "INSERT INTO cart (user_id,product_id,quantity) VALUES (?,?,?)",
    [req.user.id, product_id, quantity],
  );

  res.json({ message: "Added to cart" });
});

/* =========================
        WISHLIST
========================= */

app.get("/api/wishlist", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `
      SELECT products.id, products.title, products.price, products.image, wishlist.created_at
      FROM wishlist
      JOIN products ON wishlist.product_id = products.id
      WHERE wishlist.user_id = ?
      ORDER BY wishlist.created_at DESC
    `,
    [req.user.id],
  );

  res.json(rows);
});

app.get("/api/wishlist/:productId", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?",
    [req.user.id, req.params.productId],
  );

  res.json({ inWishlist: rows.length > 0 });
});

app.post("/api/wishlist", authMiddleware, async (req, res) => {
  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({ message: "product_id is required" });
  }

  await pool.query(
    `
      INSERT INTO wishlist (user_id, product_id)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP
    `,
    [req.user.id, product_id],
  );

  res.json({ message: "Added to wishlist" });
});

app.delete("/api/wishlist/:productId", authMiddleware, async (req, res) => {
  await pool.query("DELETE FROM wishlist WHERE user_id = ? AND product_id = ?", [
    req.user.id,
    req.params.productId,
  ]);

  res.json({ message: "Removed from wishlist" });
});

/* =========================
        START
========================= */

app.listen(5000, () =>
  console.log("🚀 Server running on http://localhost:5000"),
);
