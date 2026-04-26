import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import { mkdir, readFile, writeFile } from "fs/promises";
import nodemailer from "nodemailer";
import twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const quoteSequenceFile = path.join(rootDir, ".data", "quote-sequence.json");
const app = express();
const PORT = Number.parseInt(process.env.PORT || "3003", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "ecoloopstumpgrinding@gmail.com";
const EMAIL_USER = process.env.EMAIL_USER || ADMIN_EMAIL;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_NOTIFICATIONS_ENABLED = Boolean(EMAIL_USER && EMAIL_PASSWORD);
const ADMIN_EMAIL_SAME_AS_SENDER = ADMIN_EMAIL.toLowerCase() === EMAIL_USER.toLowerCase();
const ADMIN_PHONE = process.env.ADMIN_PHONE || "";

const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL || "";
const ENABLE_SHEETS_SYNC = process.env.ENABLE_SHEETS_SYNC !== "false";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ limit: "10mb", extended: true }));

app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ")
  );
  next();
});

app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  const originHeader = req.headers.origin;
  if (!originHeader) {
    return next();
  }

  try {
    const requestHost = req.headers.host;
    const originHost = new URL(originHeader).host;
    const baseUrlHost = new URL(BASE_URL).host;

    const allowedHosts = new Set([requestHost, baseUrlHost]);
    if (!allowedHosts.has(originHost)) {
      return res.status(403).json({ error: "Cross-origin request denied" });
    }
  } catch {
    return res.status(403).json({ error: "Invalid origin header" });
  }

  next();
});

const bookingRateLimits = new Map();

function rateLimitBookings(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const windowMs = 15 * 60 * 1000;
  const limit = 8;

  const existing = bookingRateLimits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > existing.resetAt) {
    bookingRateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (existing.count >= limit) {
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
    res.setHeader("Retry-After", retryAfter.toString());
    return res.status(429).json({ error: "Too many requests. Please retry shortly." });
  }

  existing.count += 1;
  bookingRateLimits.set(ip, existing);
  return next();
}

const emailTransporter = EMAIL_NOTIFICATIONS_ENABLED
  ? nodemailer.createTransport({
    service: "gmail",
    family: 4,
    connectionTimeout: 15000,
    socketTimeout: 15000,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD
    }
  })
  : null;

function sanitizeText(value, maxLen = 500) {
  if (typeof value !== "string") return "";
  return value.replace(/[<>]/g, "").trim().slice(0, maxLen);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone) {
  return /^[0-9+()\-\s]{8,20}$/.test(phone);
}

let quoteSequenceLock = Promise.resolve();

async function readQuoteSequence() {
  try {
    const raw = await readFile(quoteSequenceFile, "utf8");
    const parsed = JSON.parse(raw);
    const lastNumber = Number.parseInt(parsed?.lastNumber, 10);
    return Number.isFinite(lastNumber) && lastNumber >= 0 ? lastNumber : 0;
  } catch (err) {
    if (err.code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

async function buildLeadId() {
  let nextId = "ECO-Quote001";

  quoteSequenceLock = quoteSequenceLock.then(async () => {
    const lastNumber = await readQuoteSequence();
    const nextNumber = lastNumber + 1;
    await mkdir(path.dirname(quoteSequenceFile), { recursive: true });
    await writeFile(quoteSequenceFile, JSON.stringify({ lastNumber: nextNumber }, null, 2));
    nextId = `ECO-Quote${String(nextNumber).padStart(3, "0")}`;
  });

  await quoteSequenceLock;
  return nextId;
}

function buildAdminSmsMessage(lead) {
  const compactNotes = (lead.notes || "").replace(/\s+/g, " ").trim();
  const noteText = compactNotes || "-";
  return [
    `Quote ID ${lead.id}`,
    `name = ${lead.name}`,
    `email = ${lead.email}`,
    `phone = ${lead.phone}`,
    `address = ${lead.address}`,
    `stump_count = ${lead.stump_count || "-"}`,
    `stump_diameter = ${lead.stump_diameter || "-"}`,
    `access_type = ${lead.access_type || "-"}`,
    `notes = ${noteText}`
  ].join(" | ");
}

function buildCustomerSmsMessage(lead) {
  return `Hi ${lead.name}! Your EcoLoop Stump Grinding quote request has been received. Ref: ${lead.id}. We'll be in touch within 24hrs with your fixed-price quote. Questions? Call 0485 666 610.`;
}

async function sendSMS(toPhone, message) {
  if (!twilioClient || !TWILIO_PHONE_NUMBER || !toPhone) {
    return { sent: false, reason: "SMS not configured" };
  }
  try {
    const clean = toPhone.replace(/[\s\-()]/g, "");
    const e164 = clean.startsWith("0") ? `+61${clean.slice(1)}` : clean;
    await twilioClient.messages.create({ body: message, from: TWILIO_PHONE_NUMBER, to: e164 });
    return { sent: true };
  } catch (err) {
    console.error("SMS error:", err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendAdminEmail(lead) {
  if (!emailTransporter) {
    return { sent: false, reason: "Email credentials are not configured" };
  }
  try {
    const info = await emailTransporter.sendMail({
      from: `"EcoLoop Stump Grinding" <${EMAIL_USER}>`,
      to: ADMIN_EMAIL,
      replyTo: lead.email,
      subject: `New Quote Request ${lead.id} - ${lead.name}`,
      html: `
        <h2>New Quote Request</h2>
        <p style="font-size:18px;font-weight:bold;color:#2d7a2d;">Quote ID: ${lead.id}</p>
        <ul>
          <li><strong>Name:</strong> ${lead.name}</li>
          <li><strong>Email:</strong> ${lead.email}</li>
          <li><strong>Phone:</strong> ${lead.phone}</li>
          <li><strong>Address:</strong> ${lead.address}</li>
          <li><strong>Stump Count:</strong> ${lead.stump_count || "Not provided"}</li>
          <li><strong>Stump Diameter:</strong> ${lead.stump_diameter || "Not provided"}</li>
          <li><strong>Access:</strong> ${lead.access_type || "Not provided"}</li>
          <li><strong>Preferred Date:</strong> ${lead.preferred_date || "Flexible"}</li>
          <li><strong>Preferred Time:</strong> ${lead.preferred_time || "Flexible"}</li>
        </ul>
        <p><strong>Notes</strong><br/>${(lead.notes || "-").replace(/\n/g, "<br/>")}</p>
      `
    });
    return {
      sent: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      note: ADMIN_EMAIL_SAME_AS_SENDER
        ? "Admin email uses the same Gmail account as sender; check Sent/All Mail or set a different ADMIN_EMAIL for inbox alerts."
        : undefined
    };
  } catch (err) {
    console.error("Admin email error:", err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendCustomerAcknowledgement(lead) {
  if (!emailTransporter) {
    return { sent: false, reason: "Email credentials are not configured" };
  }
  try {
    await emailTransporter.sendMail({
      from: `"EcoLoop Stump Grinding" <${EMAIL_USER}>`,
      to: lead.email,
      subject: `Quote Request Received - ${lead.id}`,
      html: `
        <h2>Thanks for your enquiry, ${lead.name}</h2>
        <p style="font-size:16px;">Your quote reference is: <strong style="color:#2d7a2d;">${lead.id}</strong></p>
        <p>We have received your quote request and will get back to you within 24 hours.</p>
        <p>If urgent, call <a href="tel:0485066663">0485066663</a>.</p>
      `
    });
    return { sent: true };
  } catch (err) {
    console.error("Customer email error:", err.message);
    return { sent: false, reason: err.message };
  }
}

async function syncLeadToGoogleSheets(lead) {
  if (!ENABLE_SHEETS_SYNC) {
    return { synced: false, reason: "Sheets sync is disabled" };
  }
  if (!GOOGLE_SHEETS_WEBHOOK_URL) {
    return { synced: false, reason: "Webhook URL not configured" };
  }

  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "bookstumpgrinding-website",
        timestamp: new Date().toISOString(),
        lead: {
          ...lead,
          sms_customer_sent: lead.sms_customer_sent ?? false
        }
      })
    });

    if (!res.ok) {
      return { synced: false, reason: `Webhook responded ${res.status}` };
    }

    const raw = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { synced: false, reason: `Webhook returned non-JSON response: ${raw.slice(0, 120)}` };
    }

    if (payload.ok === false) {
      return { synced: false, reason: payload.error || "Webhook returned ok=false" };
    }

    return { synced: true };
  } catch (err) {
    return { synced: false, reason: err.message };
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bookstumpgrinding-public",
    mode: "google-sheets-only",
    time: new Date().toISOString()
  });
});

app.post("/api/bookings", rateLimitBookings, async (req, res) => {
  const name = sanitizeText(req.body?.name, 120);
  const email = sanitizeText(req.body?.email, 180);
  const phone = sanitizeText(req.body?.phone, 40);
  const address = sanitizeText(req.body?.address, 250);
  const stumpCount = sanitizeText(req.body?.stump_count, 30);
  const stumpDiameter = sanitizeText(req.body?.stump_diameter, 300);
  const accessType = sanitizeText(req.body?.access_type, 60);
  const notes = sanitizeText(req.body?.notes, 3000);
  const photos = Array.isArray(req.body?.photos) ? req.body.photos.slice(0, 5) : [];

  if (!name || !email || !phone || !address) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!validEmail(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }
  if (!validPhone(phone)) {
    return res.status(400).json({ error: "Invalid phone format" });
  }

  const lead = {
    id: await buildLeadId(),
    name,
    email,
    phone,
    address,
    stump_count: stumpCount || "",
    stump_diameter: stumpDiameter || "",
    access_type: accessType || "",
    photos,
    notes: notes || "",
    source: "website",
    created_at: new Date().toISOString()
  };

  // Send customer and admin SMS in parallel; customer result feeds into Sheets sync
  const [customerSmsResult, adminSmsResult] = await Promise.all([
    sendSMS(lead.phone, buildCustomerSmsMessage(lead)),
    sendSMS(ADMIN_PHONE, buildAdminSmsMessage(lead))
  ]);

  const leadWithSmsFlag = { ...lead, sms_customer_sent: customerSmsResult.sent };
  const sheetResult = await syncLeadToGoogleSheets(leadWithSmsFlag);
  if (!sheetResult.synced) {
    console.warn(`Google Sheets sync skipped/failed for lead #${lead.id}: ${sheetResult.reason}`);
  }

  // Send emails in the background (don't block the response)
  Promise.all([
    sendAdminEmail(lead),
    sendCustomerAcknowledgement(lead)
  ]).catch(err => {
    console.error("Background email error:", err.message);
  });

  res.json({
    success: true,
    id: lead.id,
    message: "Quote request submitted successfully",
    sheetsSync: sheetResult,
    notifications: {
      adminSms: adminSmsResult,
      customerSms: customerSmsResult,
      email: "Sent in background"
    }
  });
});

app.use(express.static(rootDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

app.listen(PORT, () => {
  console.log(`EcoRoot server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log("Running in Google-Sheets-only mode");
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    console.log("Warning: Email notifications are disabled. Set EMAIL_USER and EMAIL_PASSWORD in .env.");
  }
  if (ADMIN_EMAIL_SAME_AS_SENDER) {
    console.log("Warning: ADMIN_EMAIL matches EMAIL_USER. Gmail may show admin notifications in Sent/All Mail instead of Inbox.");
  }
  if (!GOOGLE_SHEETS_WEBHOOK_URL || !ENABLE_SHEETS_SYNC) {
    console.log("Warning: Google Sheets sync is not fully configured; bookings will still be accepted.");
  }
});
