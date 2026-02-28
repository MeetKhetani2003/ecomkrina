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

const createSimplePdf = (title, lines) => {
  const escaped = (value) =>
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

  let content = "BT\n/F1 16 Tf\n50 800 Td\n";
  content += `(${escaped(title)}) Tj\n`;

  let currentY = 775;
  lines.forEach((line) => {
    content += `1 0 0 1 50 ${currentY} Tm\n/F1 11 Tf\n(${escaped(line)}) Tj\n`;
    currentY -= 16;
  });
  content += "ET";

  const stream = `${content}`;
  const objects = [];

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push(
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
  );
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
  );
  objects.push(
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  );
  objects.push(
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  );

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((obj) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  });

  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";

  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
};

const buildInvoicePdf = (order, items) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = subtotal * 0.1;
  const total = subtotal + tax;

  const lines = [
    `Invoice #${order.id}`,
    `Date: ${new Date(order.created_at).toLocaleString()}`,
    `Customer: ${order.name || "Customer"} (${order.email || "N/A"})`,
    "",
    "Items:",
    ...items.map(
      (item) => `${item.title}  x${item.quantity}  -  $${(item.price * item.quantity).toFixed(2)}`,
    ),
    "",
    `Subtotal: $${subtotal.toFixed(2)}`,
    `Tax (10%): $${tax.toFixed(2)}`,
    `Total: $${total.toFixed(2)}`,
  ];

  return createSimplePdf("Redstore Invoice", lines);
};

const sendInvoiceEmail = async (order, items) => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log("SMTP not configured. Skipping invoice email.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const invoicePdf = buildInvoicePdf(order, items);

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: order.email,
    subject: `Your Redstore invoice #${order.id}`,
    text: `Hi ${order.name || "Customer"}, your purchase is completed. Your invoice is attached as PDF.`,
    attachments: [
      {
        filename: `invoice-${order.id}.pdf`,
        content: invoicePdf,
      },
    ],
  });
};

const sendBackInStockAlerts = async (productIds) => {
  if (!productIds.length) return;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log("SMTP not configured. Skipping back-in-stock notifications.");
    return;
  }

  const [wishlistRows] = await pool.query(
    `
      SELECT DISTINCT users.email, users.name, products.title
      FROM wishlist
      JOIN users ON wishlist.user_id = users.id
      JOIN products ON wishlist.product_id = products.id
      WHERE wishlist.product_id IN (?)
    `,
    [productIds],
  );

  if (!wishlistRows.length) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  for (const row of wishlistRows) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: row.email,
      subject: `${row.title} is back in stock!`,
      text: `Hi ${row.name || "there"}, the product "${row.title}" from your wishlist is now available. Continue shopping on Redstore!`,
    });
  }
};

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      tax DECIMAL(10,2) NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      status VARCHAR(50) DEFAULT 'completed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      price DECIMAL(10,2) NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(30) DEFAULT 'new',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS stock INT NOT NULL DEFAULT 20
  `);
};

initDatabase().catch((error) => {
  console.error("Failed to initialize database:", error.message);
});

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

app.post("/api/users/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out" });
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

app.delete("/api/cart/:id", authMiddleware, async (req, res) => {
  await pool.query("DELETE FROM cart WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.user.id,
  ]);

  res.json({ message: "Removed" });
});

app.post("/api/orders", authMiddleware, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [cartItems] = await conn.query(
      `
        SELECT cart.product_id, cart.quantity, products.price, products.stock, products.title
        FROM cart
        JOIN products ON cart.product_id = products.id
        WHERE cart.user_id = ?
      `,
      [req.user.id],
    );

    if (!cartItems.length) {
      await conn.rollback();
      return res.status(400).json({ message: "Cart is empty" });
    }

    for (const item of cartItems) {
      if (item.stock < item.quantity) {
        await conn.rollback();
        return res
          .status(400)
          .json({ message: `${item.title} has insufficient stock` });
      }
    }

    const subtotal = cartItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const tax = subtotal * 0.1;
    const total = subtotal + tax;

    const [orderResult] = await conn.query(
      "INSERT INTO orders (user_id, subtotal, tax, total, status) VALUES (?, ?, ?, ?, 'completed')",
      [req.user.id, subtotal, tax, total],
    );

    const orderId = orderResult.insertId;

    for (const item of cartItems) {
      await conn.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)",
        [orderId, item.product_id, item.quantity, item.price],
      );

      await conn.query(
        "UPDATE products SET stock = stock - ? WHERE id = ?",
        [item.quantity, item.product_id],
      );
    }

    await conn.query("DELETE FROM cart WHERE user_id = ?", [req.user.id]);

    const [userRows] = await conn.query(
      "SELECT id, name, email FROM users WHERE id = ?",
      [req.user.id],
    );

    const orderPayload = {
      id: orderId,
      user_id: req.user.id,
      subtotal,
      tax,
      total,
      created_at: new Date(),
      name: userRows[0]?.name,
      email: userRows[0]?.email,
    };

    await conn.commit();

    await sendInvoiceEmail(orderPayload, cartItems).catch((error) => {
      console.error("Invoice email failed:", error.message);
    });

    res.json({ message: "Order placed", order: orderPayload });
  } catch (error) {
    await conn.rollback();
    console.error(error);
    res.status(500).json({ message: "Failed to place order" });
  } finally {
    conn.release();
  }
});

app.get("/api/orders/:id", authMiddleware, async (req, res) => {
  const [orders] = await pool.query(
    "SELECT orders.*, users.name, users.email FROM orders JOIN users ON orders.user_id = users.id WHERE orders.id = ? AND orders.user_id = ?",
    [req.params.id, req.user.id],
  );

  if (!orders.length) {
    return res.status(404).json({ message: "Order not found" });
  }

  const [items] = await pool.query(
    "SELECT order_items.*, products.title FROM order_items JOIN products ON order_items.product_id = products.id WHERE order_items.order_id = ?",
    [req.params.id],
  );

  res.json({ order: orders[0], items });
});

app.get("/api/orders/:id/invoice", authMiddleware, async (req, res) => {
  const [orders] = await pool.query(
    "SELECT orders.*, users.name, users.email FROM orders JOIN users ON orders.user_id = users.id WHERE orders.id = ? AND orders.user_id = ?",
    [req.params.id, req.user.id],
  );

  if (!orders.length) {
    return res.status(404).json({ message: "Order not found" });
  }

  const [items] = await pool.query(
    "SELECT order_items.*, products.title FROM order_items JOIN products ON order_items.product_id = products.id WHERE order_items.order_id = ?",
    [req.params.id],
  );

  const invoiceBuffer = buildInvoicePdf(orders[0], items);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=invoice-${orders[0].id}.pdf`,
  );
  res.send(invoiceBuffer);
});

app.get("/api/wishlist", authMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    `
      SELECT products.id, products.title, products.price, products.image, products.stock, wishlist.created_at
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

app.post("/api/inquiries", async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ message: "All fields are required" });
  }

  await pool.query(
    "INSERT INTO inquiries (name, email, message) VALUES (?, ?, ?)",
    [name, email, message],
  );

  res.json({ message: "Inquiry submitted" });
});

app.get("/api/admin/summary", adminMiddleware, async (req, res) => {
  const [[{ totalProducts }]] = await pool.query(
    "SELECT COUNT(*) AS totalProducts FROM products",
  );
  const [[{ lowStock }]] = await pool.query(
    "SELECT COUNT(*) AS lowStock FROM products WHERE stock <= 5",
  );
  const [[{ totalOrders }]] = await pool.query(
    "SELECT COUNT(*) AS totalOrders FROM orders",
  );
  const [[{ newInquiries }]] = await pool.query(
    "SELECT COUNT(*) AS newInquiries FROM inquiries WHERE status = 'new'",
  );

  res.json({ totalProducts, lowStock, totalOrders, newInquiries });
});

app.get("/api/admin/inquiries", adminMiddleware, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM inquiries ORDER BY created_at DESC",
  );

  res.json(rows);
});

app.put("/api/admin/inquiries/:id", adminMiddleware, async (req, res) => {
  const { status } = req.body;
  await pool.query("UPDATE inquiries SET status = ? WHERE id = ?", [
    status || "resolved",
    req.params.id,
  ]);

  res.json({ message: "Inquiry updated" });
});

app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid admin password" });
  }

  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  res.cookie("admin_token", token, {
    httpOnly: true,
    sameSite: "lax",
  });

  res.json({ message: "Admin login success" });
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.json({ message: "Admin logged out" });
});

app.listen(5000, () =>
  console.log("🚀 Server running on http://localhost:5000"),
);
