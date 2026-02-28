import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import mysql from "mysql2/promise";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
dotenv.config();
const app = express();

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());

app.use(express.json());
app.use(cookieParser());
app.use(express.static("./"));
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});
/* =========================
   DATABASE
========================= */
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "ecomm",
});

/* =========================
   IMAGE UPLOAD
========================= */
const uploadDir = "./images";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  }),
});

/* =========================
   AUTH MIDDLEWARE
========================= */
const authMiddleware = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: "Login required" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};

const adminMiddleware = (req, res, next) => {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ message: "Admin login required" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.admin) throw new Error();
    next();
  } catch {
    res.status(401).json({ message: "Invalid admin token" });
  }
};

/* =========================
   ADMIN LOGIN
========================= */
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ message: "Invalid password" });

  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  res.cookie("admin_token", token, { httpOnly: true });
  res.json({ message: "Admin login success" });
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.json({ message: "Logged out" });
});

/* =========================
   ADMIN SUMMARY
========================= */
app.get("/api/admin/summary", adminMiddleware, async (req, res) => {
  const [[{ totalProducts }]] = await pool.query(
    "SELECT COUNT(*) totalProducts FROM products",
  );

  const [[{ lowStock }]] = await pool.query(
    "SELECT COUNT(*) lowStock FROM products WHERE stock <= 5",
  );

  const [[{ totalOrders }]] = await pool.query(
    "SELECT COUNT(*) totalOrders FROM orders",
  );

  const [[{ newInquiries }]] = await pool.query(
    "SELECT COUNT(*) newInquiries FROM inquiries WHERE status='new'",
  );

  res.json({ totalProducts, lowStock, totalOrders, newInquiries });
});

/* =========================
   PRODUCTS
========================= */
app.get("/api/products", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

app.post(
  "/api/products",
  adminMiddleware,
  upload.single("image"),
  async (req, res) => {
    const { title, price, description, Rating, stock } = req.body;
    const image = req.file ? "images/" + req.file.filename : null;

    await pool.query(
      "INSERT INTO products (title,price,image,description,Rating,stock) VALUES (?,?,?,?,?,?)",
      [title, price, image, description, Rating || 0, stock || 0],
    );

    res.json({ message: "Product added" });
  },
);
/* =========================
   SINGLE PRODUCT DETAILS
========================= */
app.get("/api/products/:id", async (req, res) => {
  const productId = req.params.id;

  const [[product]] = await pool.query("SELECT * FROM products WHERE id=?", [
    productId,
  ]);

  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  // Recommended products (exclude current)
  const [recommended] = await pool.query(
    "SELECT id, title, price, image FROM products WHERE id != ? ORDER BY id DESC LIMIT 4",
    [productId],
  );

  res.json({
    ...product,
    recommended,
  });
});
app.put("/api/products/:id", adminMiddleware, async (req, res) => {
  const { title, price, description, Rating, stock } = req.body;

  await pool.query(
    "UPDATE products SET title=?,price=?,description=?,Rating=?,stock=? WHERE id=?",
    [title, price, description, Rating, stock, req.params.id],
  );

  res.json({ message: "Updated successfully" });
});

app.delete("/api/products/:id", adminMiddleware, async (req, res) => {
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
    secure: false, // important for localhost
  });

  res.json({ message: "Login success" });
});
/* =========================
   USER PROFILE
========================= */
app.get("/api/users/profile", authMiddleware, async (req, res) => {
  const [[user]] = await pool.query(
    "SELECT id, name, email FROM users WHERE id=?",
    [req.user.id],
  );

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json(user);
});
/* =========================
   CART ROUTES
========================= */

// Get Cart
app.get("/api/cart", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT cart.id,
            products.id AS product_id,
            products.title,
            products.price,
            products.image,
            products.stock,
            cart.quantity
     FROM cart
     JOIN products ON cart.product_id = products.id
     WHERE cart.user_id=?`,
    [req.user.id],
  );

  res.json(rows);
});
app.get("/api/wishlist", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT products.id,
            products.title,
            products.price,
            products.image
     FROM wishlist
     JOIN products ON wishlist.product_id = products.id
     WHERE wishlist.user_id=?`,
    [req.user.id],
  );

  res.json(rows);
});
// Add to Cart
app.post("/api/cart", authMiddleware, async (req, res) => {
  const { product_id, quantity } = req.body;

  await pool.query(
    `INSERT INTO cart (user_id,product_id,quantity)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
    [req.user.id, product_id, quantity || 1],
  );

  res.json({ message: "Added to cart" });
});

// Remove from Cart
app.delete("/api/cart/:id", authMiddleware, async (req, res) => {
  await pool.query("DELETE FROM cart WHERE id=? AND user_id=?", [
    req.params.id,
    req.user.id,
  ]);

  res.json({ message: "Removed from cart" });
});
app.post("/api/orders", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  // Get user email
  const [[user]] = await pool.query(
    "SELECT email, name FROM users WHERE id=?",
    [userId],
  );

  const [cartItems] = await pool.query(
    `SELECT cart.product_id,
            cart.quantity,
            products.price,
            products.stock,
            products.title
     FROM cart
     JOIN products ON cart.product_id = products.id
     WHERE cart.user_id=?`,
    [userId],
  );

  if (!cartItems.length)
    return res.status(400).json({ message: "Cart is empty" });

  let subtotal = 0;

  for (const item of cartItems) {
    if (item.stock < item.quantity)
      return res.status(400).json({ message: "Not enough stock" });

    subtotal += item.price * item.quantity;
  }

  const tax = subtotal * 0.1;
  const total = subtotal + tax;

  const [orderResult] = await pool.query(
    "INSERT INTO orders (user_id,total) VALUES (?,?)",
    [userId, total],
  );

  const orderId = orderResult.insertId;

  for (const item of cartItems) {
    await pool.query(
      "INSERT INTO order_items (order_id,product_id,quantity,price) VALUES (?,?,?,?)",
      [orderId, item.product_id, item.quantity, item.price],
    );

    await pool.query("UPDATE products SET stock = stock - ? WHERE id=?", [
      item.quantity,
      item.product_id,
    ]);
  }

  await pool.query("DELETE FROM cart WHERE user_id=?", [userId]);

  /* =========================
     GENERATE PDF IN MEMORY
  ========================= */

  const doc = new PDFDocument();
  const buffers = [];

  doc.on("data", buffers.push.bind(buffers));

  doc.fontSize(20).text("Redstore Invoice", { align: "center" });
  doc.moveDown();

  doc.fontSize(12).text(`Order ID: ${orderId}`);
  doc.text(`Customer: ${user.name}`);
  doc.text(`Date: ${new Date().toLocaleDateString()}`);
  doc.moveDown();

  doc.text("------------------------------------------------");

  cartItems.forEach((item) => {
    const rowTotal = item.price * item.quantity;
    doc.text(`${item.title} | Qty: ${item.quantity} | $${rowTotal.toFixed(2)}`);
  });

  doc.moveDown();
  doc.text("------------------------------------------------");
  doc.text(`Subtotal: $${subtotal.toFixed(2)}`);
  doc.text(`Tax (10%): $${tax.toFixed(2)}`);
  doc.fontSize(14).text(`Total: $${total.toFixed(2)}`);

  doc.end();

  doc.on("end", async () => {
    const pdfData = Buffer.concat(buffers);

    await transporter.sendMail({
      from: `"Redstore" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: `Invoice for Order #${orderId}`,
      text: "Thank you for your purchase. Please find attached invoice.",
      attachments: [
        {
          filename: `Invoice-Order-${orderId}.pdf`,
          content: pdfData,
        },
      ],
    });
  });

  res.json({
    message: "Order placed successfully. Invoice sent to email.",
    orderId,
  });
});
app.get("/api/users/orders", authMiddleware, async (req, res) => {
  const [orders] = await pool.query(
    "SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC",
    [req.user.id],
  );

  res.json(orders);
});

app.get("/api/orders/:id", authMiddleware, async (req, res) => {
  const orderId = req.params.id;

  const [[order]] = await pool.query(
    "SELECT * FROM orders WHERE id=? AND user_id=?",
    [orderId, req.user.id],
  );

  if (!order) return res.status(404).json({ message: "Order not found" });

  const [items] = await pool.query(
    `SELECT order_items.*, products.title
     FROM order_items
     JOIN products ON order_items.product_id = products.id
     WHERE order_id=?`,
    [orderId],
  );

  res.json({ order, items });
});
app.get("/api/orders/:id/invoice", authMiddleware, async (req, res) => {
  const orderId = req.params.id;

  const [[order]] = await pool.query(
    "SELECT * FROM orders WHERE id=? AND user_id=?",
    [orderId, req.user.id],
  );

  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }

  const [items] = await pool.query(
    `SELECT order_items.*, products.title
     FROM order_items
     JOIN products ON order_items.product_id = products.id
     WHERE order_items.order_id=?`,
    [orderId],
  );

  // Create PDF
  const doc = new PDFDocument({ margin: 50 });

  // Set headers for download
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=Invoice-Order-${order.id}.pdf`,
  );

  doc.pipe(res);

  // Title
  doc.fontSize(20).text("Redstore Invoice", { align: "center" });
  doc.moveDown();

  doc.fontSize(12).text(`Order ID: ${order.id}`);
  doc.text(`Date: ${new Date(order.created_at).toLocaleDateString()}`);
  doc.moveDown();

  doc.text("------------------------------------------------------------");
  doc.moveDown();

  let subtotal = 0;

  items.forEach((item) => {
    const rowTotal = item.price * item.quantity;
    subtotal += rowTotal;

    doc.text(`${item.title} | Qty: ${item.quantity} | $${rowTotal.toFixed(2)}`);
  });

  const tax = subtotal * 0.1;
  const total = subtotal + tax;

  doc.moveDown();
  doc.text("------------------------------------------------------------");
  doc.moveDown();

  doc.text(`Subtotal: $${subtotal.toFixed(2)}`);
  doc.text(`Tax (10%): $${tax.toFixed(2)}`);
  doc.fontSize(14).text(`Total: $${total.toFixed(2)}`);

  doc.end();
});
/* =========================
   INQUIRIES
========================= */
app.post("/api/inquiries", async (req, res) => {
  const { name, email, message } = req.body;

  await pool.query(
    "INSERT INTO inquiries (name,email,message) VALUES (?,?,?)",
    [name, email, message],
  );

  res.json({ message: "Inquiry sent" });
});

app.get("/api/admin/inquiries", adminMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM inquiries ORDER BY created_at DESC",
  );
  res.json(rows);
});

app.put("/api/admin/inquiries/:id", adminMiddleware, async (req, res) => {
  await pool.query("UPDATE inquiries SET status=? WHERE id=?", [
    req.body.status,
    req.params.id,
  ]);
  res.json({ message: "Updated" });
});
/* =========================
   CHECK IF PRODUCT IN WISHLIST
========================= */
app.get("/api/wishlist/:productId", authMiddleware, async (req, res) => {
  const productId = req.params.productId;

  const [rows] = await pool.query(
    "SELECT id FROM wishlist WHERE user_id=? AND product_id=?",
    [req.user.id, productId],
  );

  res.json({
    inWishlist: rows.length > 0,
  });
});

/* =========================
   REMOVE FROM WISHLIST
========================= */
app.delete("/api/wishlist/:productId", authMiddleware, async (req, res) => {
  await pool.query("DELETE FROM wishlist WHERE user_id=? AND product_id=?", [
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
