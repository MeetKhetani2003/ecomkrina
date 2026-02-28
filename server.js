import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import mysql from "mysql2/promise";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "http://localhost:5000",
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser());
app.use(express.static("./"));

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
*/
const uploadDir = "./images";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

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

const adminMiddleware = (req, res, next) => {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ message: "Admin login required" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.admin) throw new Error("Not admin");
    next();
  } catch {
    return res.status(401).json({ message: "Invalid admin token" });
  }
};

app.get("/api/products", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

app.get("/api/products/:id", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM products WHERE id=?", [
    req.params.id,
  ]);

  if (!rows.length) return res.status(404).json({ message: "Product not found" });

  const product = rows[0];

  const [recommended] = await pool.query(
    "SELECT id, title, price, image, stock FROM products WHERE id != ? ORDER BY id DESC LIMIT 4",
    [req.params.id],
  );

  res.json({ ...product, recommended });
});

app.post("/api/products", adminMiddleware, upload.single("image"), async (req, res) => {
  const { title, price, description, Rating, stock } = req.body;
  const imagePath = req.file ? `images/${req.file.filename}` : null;

  const ratingValue = parseInt(Rating) || 0;
  const stockValue = Math.max(0, parseInt(stock) || 0);

  if (ratingValue < 0 || ratingValue > 5)
    return res.status(400).json({ message: "Rating 0-5 only" });

  await pool.query(
    "INSERT INTO products (title, price, image, description, Rating, stock) VALUES (?,?,?,?,?,?)",
    [title, price, imagePath, description, ratingValue, stockValue],
  );

  res.json({ message: "Product added" });
});

app.put("/api/products/:id", adminMiddleware, async (req, res) => {
  const { title, price, description, Rating, stock } = req.body;

  const ratingValue = parseInt(Rating);
  const stockValue = Math.max(0, parseInt(stock) || 0);

  if (ratingValue < 0 || ratingValue > 5)
    return res.status(400).json({ message: "Rating 0-5 only" });

  const [beforeRows] = await pool.query("SELECT stock FROM products WHERE id = ?", [
    req.params.id,
  ]);

  if (!beforeRows.length) {
    return res.status(404).json({ message: "Product not found" });
  }

  await pool.query(
    "UPDATE products SET title=?, price=?, description=?, Rating=?, stock=? WHERE id=?",
    [title, price, description, ratingValue, stockValue, req.params.id],
  );

  if (beforeRows[0].stock <= 0 && stockValue > 0) {
    await sendBackInStockAlerts([req.params.id]);
  }

  res.json({ message: "Updated successfully" });
});

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

app.delete("/api/products/:id", adminMiddleware, async (req, res) => {
  const [rows] = await pool.query("SELECT image FROM products WHERE id=?", [
    req.params.id,
  ]);

  if (rows.length && rows[0].image && fs.existsSync(rows[0].image))
    fs.unlinkSync(rows[0].image);

  await pool.query("DELETE FROM products WHERE id=?", [req.params.id]);

  res.json({ message: "Deleted" });
});

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

app.get("/api/users/orders", authMiddleware, async (req, res) => {
  const [orders] = await pool.query(
    "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.id],
  );

  res.json(orders);
});

app.get("/api/users", adminMiddleware, async (req, res) => {
  const [users] = await pool.query("SELECT id, name, email FROM users ORDER BY id DESC");
  res.json(users);
});

app.get("/api/cart", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `
    SELECT cart.id, products.id AS product_id, products.title, products.price, products.image, products.stock, cart.quantity
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
  const qty = Math.max(1, parseInt(quantity) || 1);

  const [products] = await pool.query("SELECT stock FROM products WHERE id = ?", [
    product_id,
  ]);

  if (!products.length) {
    return res.status(404).json({ message: "Product not found" });
  }

  if (products[0].stock <= 0) {
    return res.status(400).json({ message: "Product is out of stock" });
  }

  await pool.query(
    `
      INSERT INTO cart (user_id,product_id,quantity)
      VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)
    `,
    [req.user.id, product_id, qty],
  );

  res.json({ message: "Added to cart" });
});

/* =========================
        WISHLIST
*/
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
*/
app.listen(5000, () =>
  console.log("🚀 Server running on http://localhost:5000"),
);
