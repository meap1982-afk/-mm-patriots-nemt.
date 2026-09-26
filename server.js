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
  const timeType = input.timeType === "Will Call" ? "Will Call" : input.timeType === "Scheduled" || input.time ? "Scheduled" : "Will Call";
  const status = Math.max(0, Math.min(5, Number(input.status || 0)));
  const patientFirstName = cleanString(input.patientFirstName, 75);
  const patientLastName = cleanString(input.patientLastName, 75);
  const payerType = input.payerType === "Patient" ? "Patient" : input.payerType === "Other" ? "Other" : input.payerType === "NoPay" ? "NoPay" : "";
  const patientPays = payerType === "NoPay" ? "No" : cleanString(input.patientPays, 5);
  const paymentByPhone = payerType === "NoPay" ? "" : input.paymentByPhone === "Yes" ? "Yes" : input.paymentByPhone === "No" ? "No" : "";
  return {
    id: cleanString(input.id, 80), group: cleanString(input.group, 80), leg: cleanString(input.leg, 1),
    label: cleanString(input.label, 60),
    returnPending: input.returnPending === true && input.leg === "B" && String(input.group || "").startsWith("RT-"),
    patientFirstName, patientLastName,
    patient: patientFirstName && patientLastName ? `${patientFirstName} ${patientLastName}` : cleanString(input.patient, 150),
    phone: cleanString(input.phone, 40),
    weight: Math.max(0, Number(input.weight || 0)), type: cleanString(input.type, 40),
    needsWheelchair: input.needsWheelchair === "Yes" ? "Yes" : input.needsWheelchair === "No" ? "No" : ["Wheelchair", "Bariatric Wheelchair"].includes(input.type) ? "Yes" : "No",
    needsOxygen: input.needsOxygen === "Yes" ? "Yes" : "No",
    hasStairs: input.hasStairs === "Yes" ? "Yes" : input.hasStairs === "No" ? "No" : "",
    stairsCount: input.hasStairs === "Yes" ? Math.max(0, Math.min(999, Math.trunc(Number(input.stairsCount) || 0))) : 0,
    hasCompanion: input.hasCompanion === "Yes" ? "Yes" : input.hasCompanion === "No" ? "No" : "",
    twoMen: cleanString(input.twoMen, 5),
    needsHelper: cleanString(input.needsHelper, 5), helperDriver: cleanString(input.helperDriver, 100),
    paymentSource: cleanString(input.paymentSource, 30),
collection: cleanString(input.collection, 20),
paymentMethod: cleanString(input.paymentMethod, 20),
patientAmount: payerType === "NoPay" ? 0 : Math.max(0, Number(input.patientAmount || 0)),
paymentCollected: payerType === "NoPay" ? false : Boolean(input.paymentCollected),
payment: cleanString(input.payment, 80),
payStatus: cleanString(input.payStatus, 30),
patientPays,
payerType,
payerFirstName: payerType === "NoPay" ? "" : patientPays === "Yes" && payerType === "Patient" ? patientFirstName : cleanString(input.payerFirstName, 75),
payerLastName: payerType === "NoPay" ? "" : patientPays === "Yes" && payerType === "Patient" ? patientLastName : cleanString(input.payerLastName, 75),
payerRelationship: payerType === "NoPay" ? "" : patientPays === "Yes" && payerType === "Patient" ? "Self" : cleanString(input.payerRelationship, 80),
paymentByPhone,
collectedBy: cleanString(input.collectedBy, 100),
collectedAt: cleanString(input.collectedAt, 100),
    auth: cleanString(input.auth, 150), notes: cleanString(input.notes, 1500), created: Number(input.created || Date.now()),
    time: timeType === "Will Call" ? "" : cleanString(input.time, 30), timeType, driver: cleanString(input.driver, 100),
    pickup: { type: cleanString(input.pickup?.type, 60), address: cleanString(input.pickup?.address, 300), room: cleanString(input.pickup?.room, 80) },
    dropoff: { type: cleanString(input.dropoff?.type, 60), address: cleanString(input.dropoff?.address, 300), room: cleanString(input.dropoff?.room, 80) },
    status, events: Array.isArray(input.events) ? input.events.slice(-20) : []
  };
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

app.get("/api/health", async (_req, res) => {
  try {
    // Readiness includes the database and the shift schema required by GPS.
    await pool.query("SELECT 1 FROM driver_shifts LIMIT 1");
    res.json({ ok: true, version: "driver-location-v1", commit: process.env.RAILWAY_GIT_COMMIT_SHA || null });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.get("/api/config", (_req, res) => res.json({ drivers }));

app.post("/api/login", async (req, res, next) => {
  const role = req.body?.role === "dispatch" ? "dispatch" : "driver";
  const driver = cleanString(req.body?.driver, 100);
  const valid = role === "dispatch" ? safeEqual(req.body?.code, dispatchCode)
    : drivers.includes(driver) && safeEqual(req.body?.code, driverAccessCodes[driver]);
  if (!valid || (role === "driver" && !drivers.includes(driver))) return res.status(401).json({ error: "Invalid access code." });
  const sid = crypto.randomUUID();
  try {
    if (role === "driver") await pool.query("INSERT INTO driver_shifts (driver, session_id, active, expires_at) VALUES ($1,$2,true,NOW() + INTERVAL '12 hours') ON CONFLICT (driver) DO UPDATE SET session_id=$2, active=true, expires_at=NOW() + INTERVAL '12 hours'", [driver, sid]);
  } catch (error) { return next(error); }
  const token = jwt.sign({ sid, role, driver: role === "driver" ? driver : "" }, jwtSecret, { algorithm: "HS256", expiresIn: "12h" });
  res.json({ token, role, driver: role === "driver" ? driver : "" });
});

// A shift row serializes uploads and checkout, including requests already in flight.
app.get("/api/driver-locations", auth, dispatchOnly, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT s.driver, l.latitude, l.longitude, l.accuracy,
      l.updated_at, l.recorded_at, (l.recorded_at > NOW() - INTERVAL '60 seconds') AS current
      FROM driver_shifts s LEFT JOIN driver_locations l
      ON l.driver=s.driver AND l.session_id=s.session_id
      WHERE s.active AND s.expires_at > NOW() ORDER BY s.driver`);
    res.json({ locations: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/driver-location", auth, async (req, res, next) => {
  if (req.user.role !== "driver" || !req.user.sid || !drivers.includes(req.user.driver))
    return res.status(403).json({ error: "Check in again." });
  const { latitude, longitude, accuracy, recordedAt } = req.body || {};
  const timestamp = Date.parse(recordedAt);
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000 ||
      !Number.isFinite(timestamp) || timestamp > Date.now() + 10000 || timestamp < Date.now() - 60000)
    return res.status(400).json({ error: "A fresh, valid location is required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shift = await client.query("SELECT 1 FROM driver_shifts WHERE driver=$1 AND session_id=$2 AND active FOR UPDATE", [req.user.driver, req.user.sid]);
    if (!shift.rowCount) {
      await client.query("ROLLBACK");
      return res.status(401).json({ error: "Shift ended. Check in again." });
    }
    await client.query(`INSERT INTO driver_locations (driver, latitude, longitude, accuracy, recorded_at, session_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (driver) DO UPDATE SET
      latitude=$2, longitude=$3, accuracy=$4, recorded_at=$5, session_id=$6, updated_at=NOW()
      WHERE driver_locations.session_id IS DISTINCT FROM $6 OR driver_locations.recorded_at <= $5`,
      [req.user.driver, latitude, longitude, accuracy, new Date(timestamp), req.user.sid]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.delete("/api/driver-location", auth, async (req, res, next) => {
  if (req.user.role !== "driver") return res.status(403).json({ error: "Driver access required." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE driver_shifts SET active=false WHERE driver=$1 AND session_id=$2", [req.user.driver, req.user.sid]);
    await client.query("DELETE FROM driver_locations WHERE driver=$1 AND session_id=$2", [req.user.driver, req.user.sid]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) { await client.query("ROLLBACK"); next(error); }
  finally { client.release(); }
});

app.get("/api/trips", auth, async (req, res, next) => {
  try {
    const result = req.user.role === "dispatch"
      ? await pool.query("SELECT data FROM trips ORDER BY created_at DESC")
      : await pool.query("SELECT data FROM trips WHERE (data->>'driver'=$1 OR data->>'helperDriver'=$1) AND data->>'returnPending' IS DISTINCT FROM 'true' ORDER BY created_at DESC", [req.user.driver]);
    res.json({ trips: result.rows.map((row) => row.data) });
  } catch (error) { next(error); }
});

app.post("/api/trips", auth, dispatchOnly, async (req, res, next) => {
  const incoming = Array.isArray(req.body?.trips) ? req.body.trips.slice(0, 2).map(normalizeTrip) : [];
  for (const trip of incoming) {
    // New R/T return legs are held by Dispatch, regardless of the client's version.
    trip.returnPending = trip.leg === "B" && trip.group.startsWith("RT-");
    if (trip.returnPending) trip.status = 0;
  }
  if (!incoming.length || incoming.some((trip) => !trip.id || !trip.patient ||
      (Boolean(trip.patientFirstName) !== Boolean(trip.patientLastName)) ||
      !trip.pickup.address || !trip.dropoff.address ||
      (trip.timeType === "Scheduled" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(trip.time)) ||
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
    if (trip.returnPending === true && (req.user.role !== "dispatch" || req.body?.action === "advance")) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This return is pending. Dispatch must send it to the driver first." });
    }
    if (req.user.role === "driver" && ["advance", "collectPayment"].includes(req.body?.action)) {
      const online = await client.query(
        "SELECT 1 FROM driver_locations l JOIN driver_shifts s ON s.driver=l.driver AND s.session_id=l.session_id WHERE l.driver=$1 AND s.session_id=$2 AND s.active AND l.recorded_at > NOW() - INTERVAL '60 seconds'",
        [req.user.driver, req.user.sid]
      );
      if (!online.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Go online and share your current location before updating a trip." });
      }
    }
    const updates = [trip];
    if (req.body?.action === "releaseReturn") {
      if (req.user.role !== "dispatch") {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Only Dispatch can send a pending return." });
      }
      if (trip.returnPending !== true || trip.leg !== "B" || !String(trip.group || "").startsWith("RT-")) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This trip is not a pending return." });
      }
      if (!drivers.includes(trip.driver)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Assign a driver before sending the return." });
      }
      trip.returnPending = false;
      trip.events = [...(trip.events || []), { status: "Return dispatched", time: new Date().toISOString(), by: "Dispatch" }].slice(-20);
    } else if (req.body?.action === "advance") {
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

const publicFiles = new Set(["/", "/index.html", "/app.js", "/logo.jpeg", "/manifest.json", "/service-worker.js", "/support.html"]);
app.use((req, res, next) => {
  if (!publicFiles.has(req.path)) return next();
  if (["/", "/index.html", "/app.js", "/service-worker.js"].includes(req.path)) res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, req.path === "/" ? "index.html" : req.path.slice(1)));
});
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: "Server error. Please try again." }); });

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS driver_locations (
    driver TEXT PRIMARY KEY,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS session_id TEXT");
  await pool.query(`CREATE TABLE IF NOT EXISTS driver_shifts (
    driver TEXT PRIMARY KEY, session_id TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  return app.listen(port, () => console.log(`M&M Patriots NEMT listening on ${port}`));
}

if (require.main === module) start().catch((error) => { console.error(error); process.exit(1); });
module.exports = { app, start };
