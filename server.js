"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;
const dispatchCode = process.env.DISPATCH_ACCESS_CODE;
const drivers = (process.env.DRIVER_NAMES || "Carlos R.,Jose L.,Ana M.")
  .split(",").map((name) => name.trim()).filter(Boolean);
const driverAccessCodes = JSON.parse(process.env.DRIVER_ACCESS_CODES || "{}");

if (!process.env.DATABASE_URL || !jwtSecret || !dispatchCode) {
  throw new Error("DATABASE_URL, JWT_SECRET and DISPATCH_ACCESS_CODE are required");
}
const configuredCodes = drivers.map((name) => driverAccessCodes[name]);
if (new Set(drivers).size !== drivers.length ||
    configuredCodes.some((code) => typeof code !== "string" || !/^\d{4}$/.test(code)) ||
    new Set(configuredCodes).size !== configuredCodes.length) {
  throw new Error("Every driver needs a unique four-digit DRIVER_ACCESS_CODES PIN");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try {
    req.user = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

function dispatchOnly(req, res, next) {
  if (req.user.role !== "dispatch") return res.status(403).json({ error: "Dispatch access required." });
  next();
}

function cleanString(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function normalizeTrip(input) {
  const status = Math.max(0, Math.min(5, Number(input.status || 0)));
  const patientFirstName = cleanString(input.patientFirstName, 75);
  const patientLastName = cleanString(input.patientLastName, 75);
  const payerType = input.payerType === "Patient" ? "Patient" : input.payerType === "Other" ? "Other" : "";
  const paymentByPhone = input.paymentByPhone === "Yes" ? "Yes" : input.paymentByPhone === "No" ? "No" : "";
  return {
    id: cleanString(input.id, 80), group: cleanString(input.group, 80), leg: cleanString(input.leg, 1),
    label: cleanString(input.label, 60),
    patientFirstName, patientLastName,
    patient: patientFirstName && patientLastName ? `${patientFirstName} ${patientLastName}` : cleanString(input.patient, 150),
    phone: cleanString(input.phone, 40),
    weight: Math.max(0, Number(input.weight || 0)), type: cleanString(input.type, 40),
    needsWheelchair: input.needsWheelchair === "Yes" ? "Yes" : input.needsWheelchair === "No" ? "No" : input.type === "Wheelchair" ? "Yes" : "No",
    needsOxygen: input.needsOxygen === "Yes" ? "Yes" : "No",
    hasStairs: input.hasStairs === "Yes" ? "Yes" : input.hasStairs === "No" ? "No" : "",
    stairsCount: input.hasStairs === "Yes" ? Math.max(0, Math.min(999, Math.trunc(Number(input.stairsCount) || 0))) : 0,
    hasCompanion: input.hasCompanion === "Yes" ? "Yes" : input.hasCompanion === "No" ? "No" : "",
    twoMen: cleanString(input.twoMen, 5),
    needsHelper: cleanString(input.needsHelper, 5), helperDriver: cleanString(input.helperDriver, 100),
    paymentSource: cleanString(input.paymentSource, 30),
collection: cleanString(input.collection, 20),
paymentMethod: cleanString(input.paymentMethod, 20),
patientAmount: Math.max(0, Number(input.patientAmount || 0)),
paymentCollected: Boolean(input.paymentCollected),
payment: cleanString(input.payment, 80),
payStatus: cleanString(input.payStatus, 30),
patientPays: cleanString(input.patientPays, 5),
payerType,
payerFirstName: input.patientPays === "Yes" && payerType === "Patient" ? patientFirstName : cleanString(input.payerFirstName, 75),
payerLastName: input.patientPays === "Yes" && payerType === "Patient" ? patientLastName : cleanString(input.payerLastName, 75),
payerRelationship: input.patientPays === "Yes" && payerType === "Patient" ? "Self" : cleanString(input.payerRelationship, 80),
paymentByPhone,
collectedBy: cleanString(input.collectedBy, 100),
collectedAt: cleanString(input.collectedAt, 100),
    auth: cleanString(input.auth, 150), notes: cleanString(input.notes, 1500), created: Number(input.created || Date.now()),
    time: cleanString(input.time, 30), timeType: cleanString(input.timeType, 30), driver: cleanString(input.driver, 100),
    pickup: { type: cleanString(input.pickup?.type, 60), address: cleanString(input.pickup?.address, 300), room: cleanString(input.pickup?.room, 80) },
    dropoff: { type: cleanString(input.dropoff?.type, 60), address: cleanString(input.dropoff?.address, 300), room: cleanString(input.dropoff?.room, 80) },
    status, events: Array.isArray(input.events) ? input.events.slice(-20) : []
  };
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => res.json({ drivers }));

app.post("/api/login", (req, res) => {
  const role = req.body?.role === "dispatch" ? "dispatch" : "driver";
  const driver = cleanString(req.body?.driver, 100);
  const valid = role === "dispatch" ? safeEqual(req.body?.code, dispatchCode)
    : drivers.includes(driver) && safeEqual(req.body?.code, driverAccessCodes[driver]);
  if (!valid || (role === "driver" && !drivers.includes(driver))) return res.status(401).json({ error: "Invalid access code." });
  const token = jwt.sign({ role, driver: role === "driver" ? driver : "" }, jwtSecret, { algorithm: "HS256", expiresIn: "12h" });
  res.json({ token, role, driver: role === "driver" ? driver : "" });
});

app.get("/api/trips", auth, async (req, res, next) => {
  try {
    const result = req.user.role === "dispatch"
      ? await pool.query("SELECT data FROM trips ORDER BY created_at DESC")
      : await pool.query("SELECT data FROM trips WHERE data->>'driver'=$1 OR data->>'helperDriver'=$1 ORDER BY created_at DESC", [req.user.driver]);
    res.json({ trips: result.rows.map((row) => row.data) });
  } catch (error) { next(error); }
});

app.post("/api/trips", auth, dispatchOnly, async (req, res, next) => {
  const incoming = Array.isArray(req.body?.trips) ? req.body.trips.slice(0, 2).map(normalizeTrip) : [];
  if (!incoming.length || incoming.some((trip) => !trip.id || !trip.patient ||
      (Boolean(trip.patientFirstName) !== Boolean(trip.patientLastName)) ||
      !trip.pickup.address || !trip.dropoff.address ||
      (trip.hasStairs === "Yes" && trip.stairsCount < 1) ||
      (trip.patientPays === "Yes" && (!trip.payerType || !trip.payerFirstName || !trip.payerLastName ||
        (trip.payerType === "Other" && !trip.payerRelationship))))) {
    return res.status(400).json({ error: "Required trip information is missing." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const trip of incoming) {
      await client.query("INSERT INTO trips (id,data,created_at,updated_at) VALUES ($1,$2,to_timestamp($3/1000.0),NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()", [trip.id, trip, trip.created]);
    }
    await client.query("COMMIT");
    res.status(201).json({ trips: incoming });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.patch("/api/trips/:id", auth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const initial = await client.query("SELECT data FROM trips WHERE id=$1", [req.params.id]);
    if (!initial.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip not found." });
    }
    const group = initial.rows[0].data.group;
    const locked = group
      ? await client.query("SELECT id, data FROM trips WHERE data->>'group'=$1 ORDER BY id FOR UPDATE", [group])
      : await client.query("SELECT id, data FROM trips WHERE id=$1 FOR UPDATE", [req.params.id]);
    const rows = locked.rows;
    const row = rows.find((item) => item.id === req.params.id);
    if (!row) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip not found." });
    }
    const trip = row.data;
    const assigned = trip.driver === req.user.driver || trip.helperDriver === req.user.driver;
    if (req.user.role !== "dispatch" && !assigned) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "This trip is not assigned to you." });
    }
    const updates = [trip];
    if (req.body?.action === "advance") {
      const status = Number(trip.status || 0);
      if (status >= 5) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Trip is already completed." });
      }
      if (trip.leg === "B" && String(trip.group || "").startsWith("RT-") &&
          trip.patientPays === "Yes" && !trip.paymentCollected && status === 4) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Collect the R/T payment before completing the return trip." });
      }
      const labels = ["Assigned", "Accepted", "Arrived at Pickup", "Patient Picked Up", "Arrived at Destination", "Completed"];
      trip.status = status + 1;
      trip.events = [...(trip.events || []), {
        status: labels[trip.status], time: new Date().toISOString(), by: req.user.driver || "Dispatch"
      }].slice(-20);
    } else if (req.body?.action === "collectPayment") {
      if (trip.patientPays !== "Yes") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No patient payment is due." });
      }
      if (rows.some((item) => item.data.paymentCollected)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Payment has already been recorded for this trip." });
      }
      const method = cleanString(req.body?.paymentMethod, 20);
      if (!["Cash", "Check", "Credit Card"].includes(method)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Select Cash, Check, or Credit Card." });
      }
      const collectedAt = new Date().toISOString();
      for (const item of rows) {
        if (item.data.patientPays !== "Yes") continue;
        item.data.paymentCollected = true;
        item.data.payStatus = "Paid";
        item.data.paymentMethod = method;
        item.data.collectedBy = req.user.driver || "Dispatch";
        item.data.collectedAt = collectedAt;
        if (item.data !== trip) updates.push(item.data);
      }
    } else if (req.user.role === "dispatch") {
      if (Object.prototype.hasOwnProperty.call(req.body, "driver"))
        trip.driver = cleanString(req.body.driver, 100);
      if (Object.prototype.hasOwnProperty.call(req.body, "helperDriver"))
        trip.helperDriver = cleanString(req.body.helperDriver, 100);
    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Unsupported update." });
    }
    let updated;
    for (const item of updates) {
      const normalized = normalizeTrip(item);
      await client.query("UPDATE trips SET data=$2, updated_at=NOW() WHERE id=$1", [normalized.id, normalized]);
      if (item.id === trip.id) updated = normalized;
    }
    await client.query("COMMIT");
    res.json({ trip: updated });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname), { extensions: ["html"] }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: "Server error. Please try again." }); });

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  app.listen(port, () => console.log(`M&M Patriots NEMT listening on ${port}`));
}

start().catch((error) => { console.error(error); process.exit(1); });
