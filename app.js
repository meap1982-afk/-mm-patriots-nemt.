"use strict";

const steps = ["Assigned", "Accepted", "Arrived at Pickup", "Patient Picked Up", "Arrived at Destination", "Completed"];
const $ = (id) => document.getElementById(id);
let trips = [];
let drivers = [];
let session = JSON.parse(localStorage.getItem("mmSession") || "null");
let polling;

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/login") logout();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setSync(state, text) {
  $("syncStatus").className = `sync ${state}`;
  $("syncStatus").textContent = text;
}

async function loadConfig() {
  try {
    const data = await api("/config");
    drivers = data.drivers || [];
    $("loginDriver").innerHTML = drivers.map((name) => `<option>${esc(name)}</option>`).join("");
  } catch {
    $("loginMessage").textContent = "Unable to contact the server.";
  }
}

async function enter(role) {
  const code = $("accessCode").value.trim();
  if (!code) return $("loginMessage").textContent = "Enter the access code.";
  $("loginMessage").textContent = "Signing in…";
  try {
    session = await api("/login", { method: "POST", body: JSON.stringify({ role, code, driver: $("loginDriver").value }) });
    localStorage.setItem("mmSession", JSON.stringify(session));
    openApp();
  } catch (error) {
    $("loginMessage").textContent = error.message;
  }
}

function openApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("dispatchTab").classList.toggle("hidden", session.role !== "dispatch");
  $("driverName").textContent = `Driver: ${session.driver || ""}`;
  session.role === "dispatch" ? showDispatch() : showDriver();
  refreshTrips();
  clearInterval(polling);
  polling = setInterval(refreshTrips, 5000);
}

function logout() {
  clearInterval(polling);
  localStorage.removeItem("mmSession");
  session = null; trips = [];
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("accessCode").value = "";
  $("loginMessage").textContent = "Shared beta — sign in to continue.";
}

function showDispatch() {
  if (session?.role !== "dispatch") return showDriver();
  $("dispatch").classList.remove("hidden"); $("driver").classList.add("hidden");
  $("dispatchTab").classList.add("active"); $("driverTab").classList.remove("active");
  $("roleTitle").textContent = "Dispatch"; render();
}

function showDriver() {
  $("driver").classList.remove("hidden"); $("dispatch").classList.add("hidden");
  $("driverTab").classList.add("active"); $("dispatchTab").classList.remove("active");
  $("roleTitle").textContent = session?.driver ? `Driver — ${session.driver}` : "Driver"; render();
}

async function refreshTrips() {
  if (!session) return;
  try {
    const data = await api("/trips");
    trips = data.trips || [];
    setSync("online", "Synced"); render();
  } catch (error) {
    setSync("offline", "Offline");
    console.error(error);
  }
}

function loc(type, address, room) { return { type, address, room }; }

async function createTrip() {
  const required = [$("patient").value, $("phone").value, $("aPick").value, $("aDrop").value];
  if (required.some((value) => !value.trim())) return alert("Patient, phone, pickup address and drop-off address are required.");
  const now = Date.now();
  const base = {
    patient: $("patient").value, phone: $("phone").value, weight: Number($("weight").value || 0), type: $("tripType").value,
    twoMen: $("twoMen").value, needsHelper: $("needsHelper").value,
    helperDriver: $("needsHelper").value === "Yes" ? $("helperDriver").value : "",
    payment: $("payment").value, payStatus: $("payStatus").value, patientPays: $("patientPays").value,
    patientAmount: Number($("patientAmount").value || 0), paymentCollected: false, collectedBy: "", collectedAt: "",
    auth: $("auth").value, notes: $("notes").value, created: now
  };
  const group = `${$("isRT").value === "yes" ? "RT" : "OW"}-${now}`;
  const newTrips = [{ ...base, id: `A-${now}`, group, leg: "A", label: "Pickup / Outbound", time: $("aTime").value, driver: $("aDriver").value,
    pickup: loc($("aPickType").value, $("aPick").value, $("aPickRoom").value),
    dropoff: loc($("aDropType").value, $("aDrop").value, $("aDropRoom").value), status: 0, events: [] }];
  if ($("isRT").value === "yes") newTrips.push({ ...base, id: `B-${now + 1}`, group, leg: "B", label: "Return", time: $("bTime").value,
    timeType: $("bTimeType").value, driver: $("bDriver").value,
    pickup: loc($("aDropType").value, $("aDrop").value, $("aDropRoom").value),
    dropoff: loc($("aPickType").value, $("aPick").value, $("aPickRoom").value), status: 0, events: [] });
  try {
    setSync("", "Saving…");
    await api("/trips", { method: "POST", body: JSON.stringify({ trips: newTrips }) });
    await refreshTrips(); alert("Trip saved and shared with the assigned driver.");
  } catch (error) { setSync("offline", "Save failed"); alert(error.message); }
}

function esc(value) {
  return String(value || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[m]));
}

function displayDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function tripCard(t, mode) {
  const status = steps[Number(t.status || 0)] || steps[0];
  const options = [...drivers, "Unassigned"].map((name) => `<option ${name === t.driver ? "selected" : ""}>${esc(name)}</option>`).join("");
  const helperOptions = [...drivers, "Unassigned"].map((name) => `<option ${name === t.helperDriver ? "selected" : ""}>${esc(name)}</option>`).join("");
  const next = Number(t.status) < 5 ? steps[Number(t.status) + 1] : "Completed";
  return `<div class="card trip ${t.leg === "B" ? "return" : ""}">
    <div class="topline"><h3>Trip ${esc(t.leg)} — ${esc(t.label)}</h3><span class="badge ${t.leg === "B" ? "rt" : ""}">${String(t.group).startsWith("RT-") ? "R/T" : "One Way"}</span></div>
    <div><b>${esc(t.time || "Will Call")} · ${esc(t.patient)}</b> · ${esc(t.type)} ${t.twoMen === "Yes" ? "· Two-Men Team" : ""}${t.needsHelper === "Yes" ? " · Helper Required" : ""}</div>
    ${t.needsHelper === "Yes" ? `<div class="meta">🧑‍🤝‍🧑 <b>Helper Driver:</b> ${esc(t.helperDriver || "Unassigned")}</div>` : ""}
    <div class="meta">📞 <b>${esc(t.phone || "No phone")}</b>${t.weight ? ` · ⚖️ <b>${Number(t.weight)} lbs</b>` : ""}<br>📍 ${esc(t.pickup?.type)} — ${esc(t.pickup?.address)} ${esc(t.pickup?.room)}<br>🏁 ${esc(t.dropoff?.type)} — ${esc(t.dropoff?.address)} ${esc(t.dropoff?.room)}<br>💳 ${esc(t.payment)} · ${esc(t.payStatus)}<br>${t.patientPays === "Yes" ? `💵 <b>Patient Pays: YES — $${Number(t.patientAmount || 0).toFixed(2)}</b>` : "💵 Patient Pays: NO"}</div>
    ${mode === "dispatch" ? `<label>Driver — change independently</label><select onchange="changeDriver('${esc(t.id)}',this.value)">${options}</select>${t.needsHelper === "Yes" ? `<label>Helper Driver — change independently</label><select onchange="changeHelper('${esc(t.id)}',this.value)">${helperOptions}</select>` : ""}` : `<div class="step current">${esc(status)}</div>`}
    ${mode === "driver" && t.phone ? `<div class="actions"><button class="ghost" onclick="window.location.href='tel:${esc(t.phone)}'">📞 CALL PATIENT</button></div>` : ""}
    ${mode === "driver" && t.patientPays === "Yes" ? (t.paymentCollected ? `<div class="step done">✓ PAYMENT COLLECTED — $${Number(t.patientAmount || 0).toFixed(2)}<br><span class="small">Collected by ${esc(t.collectedBy)} · ${esc(displayDate(t.collectedAt))}</span></div>` : `<div class="actions"><button class="success" onclick="collectPayment('${esc(t.id)}')">PAYMENT COLLECTED — $${Number(t.patientAmount || 0).toFixed(2)}</button></div>`) : ""}
    ${mode === "driver" && Number(t.status) < 5 ? `<div class="actions"><button class="${Number(t.status) === 0 ? "success" : "primary"}" onclick="advance('${esc(t.id)}')">${Number(t.status) === 0 ? "ACCEPT TRIP" : esc(next.toUpperCase())}</button></div>` : ""}
    ${mode === "driver" && Number(t.status) === 5 ? `<div class="step done">✓ Trip Completed</div>` : ""}
    ${mode === "dispatch" ? `<div class="step ${Number(t.status) === 5 ? "done" : "current"}">${esc(status)}</div>${t.patientPays === "Yes" ? (t.paymentCollected ? `<div class="step done">✓ Payment Collected: $${Number(t.patientAmount || 0).toFixed(2)} · ${esc(t.collectedBy)} · ${esc(displayDate(t.collectedAt))}</div>` : `<div class="step current">Payment Due: $${Number(t.patientAmount || 0).toFixed(2)} — Not Collected</div>`) : ""}` : ""}
  </div>`;
}

async function patchTrip(id, body) {
  try { setSync("", "Saving…"); await api(`/trips/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }); await refreshTrips(); }
  catch (error) { setSync("offline", "Save failed"); alert(error.message); }
}

function changeDriver(id, driver) { return patchTrip(id, { driver }); }
function changeHelper(id, helperDriver) { return patchTrip(id, { helperDriver }); }
function advance(id) { return patchTrip(id, { action: "advance" }); }
function collectPayment(id) {
  const trip = trips.find((item) => item.id === id);
  if (!trip || !confirm(`Confirm that $${Number(trip.patientAmount || 0).toFixed(2)} was collected from ${trip.patient}?`)) return;
  return patchTrip(id, { action: "collectPayment" });
}

function render() {
  $("dispatchTrips").innerHTML = trips.length ? trips.map((trip) => tripCard(trip, "dispatch")).join("") : `<div class="card">No trips yet. Create the first trip above.</div>`;
  $("driverTrips").innerHTML = trips.length ? trips.map((trip) => tripCard(trip, "driver")).join("") : `<div class="card">No trips assigned to ${esc(session?.driver || "this driver")}.</div>`;
  $("kTotal").textContent = trips.length;
  $("kScheduled").textContent = trips.filter((trip) => Number(trip.status) < 1).length;
  $("kProgress").textContent = trips.filter((trip) => Number(trip.status) > 0 && Number(trip.status) < 5).length;
  $("kDone").textContent = trips.filter((trip) => Number(trip.status) === 5).length;
}

$("isRT").addEventListener("change", () => $("returnFields").classList.toggle("hidden", $("isRT").value === "no"));
$("needsHelper").addEventListener("change", () => $("helperDriverWrap").classList.toggle("hidden", $("needsHelper").value !== "Yes"));
$("helperDriverWrap").classList.add("hidden");

loadConfig().then(() => {
  for (const id of ["helperDriver", "aDriver", "bDriver"]) {
    const select = $(id);
    const current = select.value;
    select.innerHTML = [...drivers, "Unassigned"].map((name) => `<option>${esc(name)}</option>`).join("");
    if ([...drivers, "Unassigned"].includes(current)) select.value = current;
  }
  if (session?.token) openApp();
});
