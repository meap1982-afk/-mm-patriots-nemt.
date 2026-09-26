"use strict";

const steps = ["Assigned", "Accepted", "Arrived at Pickup", "Patient Picked Up", "Arrived at Destination", "Completed"];
const $ = (id) => document.getElementById(id);
let trips = [];
let drivers = [];
let session = JSON.parse(localStorage.getItem("mmSession") || "null");
let polling;
let locationTimer;
let sharingLocation = false;
let locationOnline = false;
let sendingLocation = false;

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
  if (!code) return $("loginMessage").textContent = "Enter your driver PIN or Dispatch code.";
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
  if (session.role === "driver") startLocationSharing();
  refreshTrips();
  if (session.role === "dispatch") refreshDriverLocations();
  clearInterval(polling);
  polling = setInterval(() => {
    refreshTrips();
    if (session?.role === "dispatch") refreshDriverLocations();
  }, 5000);
}

function logout() {
  stopLocationSharing();
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

async function refreshDriverLocations() {
  if (session?.role !== "dispatch") return;
  try {
    const data = await api("/driver-locations");
    const locations = data.locations || [];
    $("driverLocations").innerHTML = locations.length ? locations.map((item) => {
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      const url = `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`;
      return `<div class="step">📍 <b>${esc(item.driver)}</b> · updated ${esc(displayDate(item.updated_at))}
        · accuracy ~${Math.round(Number(item.accuracy))} m
        · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on map</a></div>`;
    }).join("") : '<div class="step">No drivers sharing a recent location.</div>';
  } catch (error) {
    $("driverLocations").textContent = "Driver locations unavailable.";
    console.error(error);
  }
}

function locationMessage(message) {
  $("locationStatus").textContent = message;
  $("shareLocation").textContent = sharingLocation ? "Check Out" : "Retry Location";
}

async function sendLocation() {
  if (!sharingLocation || sendingLocation || document.visibilityState === "hidden") return;
  sendingLocation = true;
  try {
    if (!navigator.geolocation) throw new Error("Location is unavailable on this device.");
    const position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 10000
      }));
    if (!sharingLocation) return;
    await api("/driver-location", { method: "POST", body: JSON.stringify({
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy
    }) });
    if (!sharingLocation) {
      await api("/driver-location", { method: "DELETE" });
      return;
    }
    locationOnline = true;
    locationMessage(`Online · location updated ${new Date().toLocaleTimeString()}`);
    render();
  } catch (error) {
    locationOnline = false;
    locationMessage(`Offline · location unavailable: ${error.message}`);
    render();
  } finally { sendingLocation = false; }
}

function startLocationSharing() {
  if (session?.role !== "driver" || sharingLocation) return;
  if (!window.isSecureContext) return locationMessage("Location requires an HTTPS connection.");
  sharingLocation = true;
  locationMessage("Requesting location permission…");
  sendLocation();
  locationTimer = setInterval(sendLocation, 10000);
}

function stopLocationSharing() {
  if (!sharingLocation) return;
  sharingLocation = false;
  locationOnline = false;
  clearInterval(locationTimer);
  locationMessage("Offline · location sharing stopped.");
  render();
  api("/driver-location", { method: "DELETE" }).catch((error) => console.error(error));
}

function toggleLocationSharing() {
  if (sharingLocation) logout();
  else startLocationSharing();
}

document.addEventListener("visibilitychange", () => {
  if (sharingLocation && document.visibilityState === "visible") sendLocation();
});

function loc(type, address, room) { return { type, address, room }; }

function addressFields(prefix) {
  const value = (suffix) => $(`${prefix}${suffix}`).value.trim();
  return {
    number: value("Number"), street: value("Street"), city: value("City"),
    state: value("State").toUpperCase(), zip: value("Zip"), room: value("Room")
  };
}

function addressText(fields) {
  return `${fields.number} ${fields.street}, ${fields.city}, ${fields.state} ${fields.zip}`;
}

function addressLink(location) {
  const address = String(location?.address || "").trim();
  if (!address) return "";
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(address)} in Maps">${esc(address)}</a>${location?.room ? `, ${esc(location.room)}` : ""}`;
}

async function createTrip() {
  const pickup = addressFields("aPick");
  const dropoff = addressFields("aDrop");
  const firstName = $("patientFirstName").value.trim();
  const lastName = $("patientLastName").value.trim();
  const required = [firstName, lastName, $("phone").value,
    ...[pickup, dropoff].flatMap(({ number, street, city, state, zip }) => [number, street, city, state, zip])];
  if (required.some((value) => !value.trim())) return alert("Patient first and last name, phone, and all address fields except suite/apartment are required.");
  if (![pickup, dropoff].every(({ state, zip }) => /^[A-Z]{2}$/.test(state) && /^\d{5}(-\d{4})?$/.test(zip)))
    return alert("Use a two-letter state and a 5-digit ZIP code (or ZIP+4).");
  const hasStairs = $("hasStairs").value;
  const stairsCount = hasStairs === "Yes" ? Number($("stairsCount").value) : 0;
  if (hasStairs === "Yes" && (!Number.isInteger(stairsCount) || stairsCount < 1 || stairsCount > 999))
    return alert("Enter the number of steps (1–999) when Has Stairs is Yes.");
  const payerType = $("payerType").value;
  const patientPays = payerType === "NoPay" ? "No" : "Yes";
  const paymentByPhone = patientPays === "Yes" ? $("paymentByPhone").value : "";
  const payerFirstName = patientPays !== "Yes" ? "" : payerType === "Other" ? $("payerFirstName").value.trim() : firstName;
  const payerLastName = patientPays !== "Yes" ? "" : payerType === "Other" ? $("payerLastName").value.trim() : lastName;
  const payerRelationship = patientPays !== "Yes" ? "" : payerType === "Other" ? $("payerRelationship").value.trim() : "Self";
  if (payerType === "Other" && (!payerFirstName || !payerLastName || !payerRelationship))
    return alert("Enter the name and relationship of the other person making the payment.");
  const now = Date.now();
  const base = {
    patientFirstName: firstName, patientLastName: lastName, patient: `${firstName} ${lastName}`,
    phone: $("phone").value, weight: Number($("weight").value || 0), type: $("tripType").value,
    needsWheelchair: $("needsWheelchair").value, needsOxygen: $("needsOxygen").value,
    hasStairs, stairsCount, hasCompanion: $("hasCompanion").value,
    twoMen: $("twoMen").value, needsHelper: $("needsHelper").value,
    helperDriver: $("needsHelper").value === "Yes" ? $("helperDriver").value : "",
    payment: $("payment").value, payStatus: $("payStatus").value, patientPays,
    payerType, payerFirstName, payerLastName, payerRelationship, paymentByPhone,
    patientAmount: patientPays === "Yes" ? Number($("patientAmount").value || 0) : 0, paymentCollected: patientPays === "Yes" && $("payStatus").value === "Paid",
    collectedBy: patientPays === "Yes" && $("payStatus").value === "Paid" ? "Dispatch" : "",
    collectedAt: patientPays === "Yes" && $("payStatus").value === "Paid" ? new Date().toISOString() : "",
    auth: $("auth").value, notes: $("notes").value, created: now
  };
  const group = `${$("isRT").value === "yes" ? "RT" : "OW"}-${now}`;
  const newTrips = [{ ...base, id: `A-${now}`, group, leg: "A", label: $("isRT").value === "yes" ? "Pick Up" : "One Way", time: $("aTime").value, driver: $("aDriver").value,
    pickup: loc($("aPickType").value, addressText(pickup), pickup.room),
    dropoff: loc($("aDropType").value, addressText(dropoff), dropoff.room), status: 0, events: [] }];
  if ($("isRT").value === "yes") newTrips.push({ ...base, id: `B-${now + 1}`, group, leg: "B", label: "Return", time: $("bTime").value,
    timeType: $("bTimeType").value, driver: $("bDriver").value,
    pickup: loc($("aDropType").value, addressText(dropoff), dropoff.room),
    dropoff: loc($("aPickType").value, addressText(pickup), pickup.room), status: 0, events: [] });
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

function phoneDialLink(value) {
  const phone = String(value || "").trim().replace(/\s*(?:ext\.?|extension|x)\s*\d+$/i, "");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return `tel:${phone.startsWith("+") ? "+" : ""}${digits}`;
}

function tripCard(t, mode) {
  const status = steps[Number(t.status || 0)] || steps[0];
  const roundTrip = String(t.group || "").startsWith("RT-");
  const tripLabel = roundTrip ? (t.leg === "B" ? "Return" : "Pick Up") : "One Way";
  const needsWheelchair = t.needsWheelchair === "Yes" || (t.needsWheelchair == null && t.type === "Wheelchair");
  const needsOxygen = t.needsOxygen === "Yes";
  const stairs = t.hasStairs === "Yes" ? `YES — ${Number(t.stairsCount) > 0 ? `${Number(t.stairsCount)} steps` : "count not specified"}` : t.hasStairs === "No" ? "NO" : "Not specified";
  const companion = t.hasCompanion === "Yes" ? "YES" : t.hasCompanion === "No" ? "NO" : "Not specified";
  const payerName = [t.payerFirstName, t.payerLastName].filter(Boolean).join(" ") || "Not specified";
  const phonePayment = t.paymentByPhone === "Yes" ? "YES" : t.paymentByPhone === "No" ? "NO" : "Not specified";
  const dialLink = phoneDialLink(t.phone);
  const options = [...drivers, "Unassigned"].map((name) => `<option ${name === t.driver ? "selected" : ""}>${esc(name)}</option>`).join("");
  const helperOptions = [...drivers, "Unassigned"].map((name) => `<option ${name === t.helperDriver ? "selected" : ""}>${esc(name)}</option>`).join("");
  const next = Number(t.status) < 5 ? steps[Number(t.status) + 1] : "Completed";
  return `<div class="card trip ${t.leg === "B" ? "return" : ""}">
    <div class="topline"><h3>${tripLabel}</h3>${mode === "dispatch" ? `<span class="badge ${roundTrip ? "rt" : ""}">${roundTrip ? "R/T" : "One Way"}</span>` : ""}</div>
    <div><b>${esc(t.time || "Will Call")} · ${esc(t.patient)}</b> · ${esc(t.type)} ${t.twoMen === "Yes" ? "· Two-Men Team" : ""}${t.needsHelper === "Yes" ? " · Helper Required" : ""}</div>
    <div class="step ${needsWheelchair || needsOxygen ? "current" : ""}">♿ Need Wheelchair: <b>${needsWheelchair ? "YES" : "NO"}</b><br>Need Oxygen: <b>${needsOxygen ? "YES" : "NO"}</b></div>
    <div class="step ${t.hasStairs === "Yes" ? "current" : ""}">Stairs: <b>${stairs}</b></div>
    <div class="step ${t.hasCompanion === "Yes" ? "current" : ""}">Companion: <b>${companion}</b></div>
    ${t.needsHelper === "Yes" ? `<div class="meta">🧑‍🤝‍🧑 <b>Helper Driver:</b> ${esc(t.helperDriver || "Unassigned")}</div>` : ""}
    <div class="meta">📞 <b>${esc(t.phone || "No phone")}</b>${t.weight ? ` · ⚖️ <b>${Number(t.weight)} lbs</b>` : ""}<br>📍 ${esc(t.pickup?.type)} — ${addressLink(t.pickup)}<br>🏁 ${esc(t.dropoff?.type)} — ${addressLink(t.dropoff)}<br>💳 ${esc(t.payment)} · ${esc(t.payStatus)}<br>${t.patientPays === "Yes" ? `💵 <b>Private Payment Due: $${Number(t.patientAmount || 0).toFixed(2)}</b>` : "💵 Private Payment Due: NO"}</div>
    ${t.payerType === "NoPay" ? `<div class="step">No Pay</div>` : t.patientPays === "Yes" ? `<div class="step current">${t.payerType === "Patient" ? "Patient Pays" : t.payerType === "Other" ? "Another Person Pays" : "Payer"}: <b>${esc(payerName)}</b><br>Relationship to Patient: <b>${esc(t.payerRelationship || "Not specified")}</b><br>Payment by Phone: <b>${phonePayment}</b></div>` : ""}
    ${mode === "dispatch" ? `<label>Driver — change independently</label><select onchange="changeDriver('${esc(t.id)}',this.value)">${options}</select>${t.needsHelper === "Yes" ? `<label>Helper Driver — change independently</label><select onchange="changeHelper('${esc(t.id)}',this.value)">${helperOptions}</select>` : ""}` : `<div class="step current">${esc(status)}</div>`}
    ${mode === "driver" && dialLink ? `<div class="actions"><a class="ghost call-patient" href="${esc(dialLink)}" aria-label="Call ${esc(t.patient || "patient")}">📞 CALL PATIENT</a></div>` : ""}
    ${mode === "driver" && t.patientPays === "Yes" ? (t.paymentCollected ? `<div class="step done">✓ PAYMENT COLLECTED — $${Number(t.patientAmount || 0).toFixed(2)}<br><span class="small">Collected by ${esc(t.collectedBy)} · ${esc(displayDate(t.collectedAt))}</span></div>` : `<div class="actions"><select id="paymentMethod-${esc(t.id)}" aria-label="Payment method"><option value="">Select payment method</option><option>Cash</option><option>Check</option><option>Credit Card</option></select><button class="success" onclick="collectPayment('${esc(t.id)}')" ${locationOnline ? "" : "disabled"}>RECORD PAYMENT — ${Number(t.patientAmount || 0).toFixed(2)}</button></div>`) : ""}
    ${mode === "driver" && Number(t.status) < 5 ? `<div class="actions"><button class="${Number(t.status) === 0 ? "success" : "primary"}" onclick="advance('${esc(t.id)}')" ${locationOnline ? "" : "disabled"}>${Number(t.status) === 0 ? "ACCEPT TRIP" : esc(next.toUpperCase())}</button></div>` : ""}
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
function advance(id) {
  if (!locationOnline) return alert("Go online and allow location access before updating a trip.");
  return patchTrip(id, { action: "advance" });
}
function collectPayment(id) {
  if (!locationOnline) return alert("Go online and allow location access before recording payment.");
  const trip = trips.find((item) => item.id === id);
  if (!trip || trip.paymentCollected) return;
  const paymentMethod = document.getElementById(`paymentMethod-${id}`)?.value;
  if (!paymentMethod) return alert("Select Cash, Check, or Credit Card.");
  if (!confirm(`Confirm that $${Number(trip.patientAmount || 0).toFixed(2)} was collected from ${trip.patient} by ${paymentMethod}?`)) return;
  return patchTrip(id, { action: "collectPayment", paymentMethod });
}
function render() {
  $("dispatchTrips").innerHTML = trips.length ? trips.map((trip) => tripCard(trip, "dispatch")).join("") : `<div class="card">No trips yet. Create the first trip above.</div>`;
  $("driverTrips").innerHTML = trips.length ? trips.map((trip) => tripCard(trip, "driver")).join("") : `<div class="card">No trips assigned to ${esc(session?.driver || "this driver")}.</div>`;
  $("kTotal").textContent = trips.length;
  $("kScheduled").textContent = trips.filter((trip) => Number(trip.status) < 1).length;
  $("kProgress").textContent = trips.filter((trip) => Number(trip.status) > 0 && Number(trip.status) < 5).length;
  $("kDone").textContent = trips.filter((trip) => Number(trip.status) === 5).length;
}

function updateTripService() {
  const oneWay = $("isRT").value === "no";
  $("returnFields").classList.toggle("hidden", oneWay);
  $("outboundHeading").textContent = oneWay ? "One Way" : "Pick Up";
}
$("isRT").addEventListener("change", updateTripService);
updateTripService();
$("needsHelper").addEventListener("change", () => $("helperDriverWrap").classList.toggle("hidden", $("needsHelper").value !== "Yes"));
function updatePayerFields() {
  const noPay = $("payerType").value === "NoPay";
  $("patientPays").value = noPay ? "No" : "Yes";
  $("patientAmountWrap").classList.toggle("hidden", noPay);
  $("paymentByPhoneWrap").classList.toggle("hidden", noPay);
  $("payerNameFields").classList.toggle("hidden", $("payerType").value !== "Other");
}
$("payerType").addEventListener("change", updatePayerFields);
updatePayerFields();
$("hasStairs").addEventListener("change", () => $("stairsCountWrap").classList.toggle("hidden", $("hasStairs").value !== "Yes"));
$("tripType").addEventListener("change", () => { $("needsWheelchair").value = $("tripType").value === "Wheelchair" ? "Yes" : "No"; });
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
