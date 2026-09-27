"use strict";

const steps = ["Assigned", "Accepted", "Arrived at Pickup", "Patient Picked Up", "Arrived at Destination", "Completed"];
const $ = (id) => document.getElementById(id);
let trips = [];
let drivers = [];
let session = JSON.parse(localStorage.getItem("mmSession") || "null");
let polling;
let tripFolder = "today";
let notificationRequest = null;
let driverInboxOpen = false;
let unreadNotificationCount = 0;
let editingTripId = null;
let createTripOpen = false;
let tripFormSnapshot = null;
let savingTrip = false;
let locationTimer;
let sharingLocation = false;
let locationOnline = false;
let sendingLocation = false;
let lastLocationUpdate = 0;
const nativeLocation = () => window.webkit?.messageHandlers?.driverLocation;

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const requestToken = session?.token;
  if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/login" && session?.token === requestToken) logout();
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
  driverInboxOpen = false;
  unreadNotificationCount = 0;
  updateNotificationView();
  tripFolder = "today";
  createTripOpen = false;
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("dispatchTab").classList.toggle("hidden", session.role !== "dispatch");
  $("driverName").textContent = `Driver: ${session.driver || ""}`;
  session.role === "dispatch" ? showDispatch() : showDriver();
  if (session.role === "driver") startLocationSharing();
  refreshTrips();
  refreshNotifications();
  if (session.role === "dispatch") refreshDriverLocations();
  clearInterval(polling);
  polling = setInterval(() => {
    if (locationOnline && Date.now() - lastLocationUpdate > 60000) {
      locationOnline = false;
      locationMessage("Location overdue · waiting for a fresh GPS update");
      render();
    }
    refreshTrips();
    refreshNotifications();
    if (session?.role === "dispatch") refreshDriverLocations();
  }, 5000);
}

function logout() {
  if (editingTripId) cancelTripEdit();
  stopLocationSharing();
  window.DriverFleetMap?.clear();
  clearInterval(polling);
  localStorage.removeItem("mmSession");
  stopNotificationSounds();
  session = null; trips = [];
  $("driverNotifications").innerHTML = "";
  $("notificationCount").textContent = "0";
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("accessCode").value = "";
  $("loginMessage").textContent = "Shared beta — sign in to continue.";
}

function showDispatch() {
  if (session?.role !== "dispatch") return showDriver();
  $("dispatch").classList.remove("hidden"); $("driver").classList.add("hidden");
  $("dispatchTab").classList.add("active"); $("driverTab").classList.remove("active");
  $("createTripToolbar").hidden = false;
  $("roleTitle").textContent = "Dispatch"; render();
}

function showDriver() {
  $("createTripToolbar").hidden = true;
  $("driver").classList.remove("hidden"); $("dispatch").classList.add("hidden");
  $("driverTab").classList.add("active"); $("dispatchTab").classList.remove("active");
  $("roleTitle").textContent = session?.driver ? `Driver — ${session.driver}` : "Driver"; render();
}

async function refreshTrips() {
  if (!session) return;
  const token = session.token;
  try {
    const data = await api("/trips");
    if (session?.token !== token) return;
    trips = data.trips || [];
    setSync("online", "Synced"); render();
  } catch (error) {
    setSync("offline", "Offline");
    console.error(error);
  }
}

const notificationTones = {
  assigned: [660, 880, 1100], cancelled: [440, 330, 220],
  accepted: [880, 1100], dropped_off: [523, 659, 784, 1047]
};
function notificationTitle(kind) {
  return ({ assigned: "New trip assigned", cancelled: "Trip cancelled / removed from your assignments",
    accepted: "Driver accepted trip", dropped_off: "Patient dropped off · Trip completed" })[kind] || "Trip update";
}
let notificationAudio = null;
let nextNotificationSound = 0;
let soundedEvents = new Set();
let soundedScope = "";
function stopNotificationSounds() {
  notificationAudio?.close().catch(() => {});
  notificationAudio = null;
  nextNotificationSound = 0;
  soundedEvents = new Set(); soundedScope = "";
  $("enableSounds").textContent = "Enable notification sounds";
  $("soundStatus").textContent = "Enable sounds to hear different alerts for each trip event.";
}
async function enableNotificationSounds() {
  if (session?.role === "driver" && window.nativeTripNotifications) {
    $("soundStatus").textContent = "iPhone alerts use notification permissions and sound settings. Allow notifications in Settings.";
    return;
  }
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error("Audio unavailable");
    if (!notificationAudio || notificationAudio.state === "closed") notificationAudio = new Audio();
    await notificationAudio.resume();
    $("enableSounds").textContent = "Test notification sound";
    $("soundStatus").textContent = "Sounds enabled while this app is running. Keep this tab open.";
    playNotificationSound(session?.role === "dispatch" ? "accepted" : "assigned");
    if (window.Notification?.permission === "default") window.Notification.requestPermission().catch(() => {});
    refreshNotifications();
  } catch { $("soundStatus").textContent = "Sound is blocked. Check browser permissions and try again."; }
}
function playNotificationSound(kind) {
  if (!notificationAudio || notificationAudio.state !== "running") return false;
  const notes = notificationTones[kind] || notificationTones.assigned;
  const start = Math.max(notificationAudio.currentTime, nextNotificationSound);
  notes.forEach((frequency, index) => {
    const oscillator = notificationAudio.createOscillator(), gain = notificationAudio.createGain();
    const time = start + index * 0.22;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.16, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    oscillator.connect(gain); gain.connect(notificationAudio.destination);
    oscillator.start(time); oscillator.stop(time + 0.2);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  });
  nextNotificationSound = start + notes.length * 0.22 + 0.15;
  return true;
}
function announceNotifications(notices) {
  if (session?.role === "driver" && window.nativeTripNotifications) return;
  const scope = `mmNotificationSounds:${session?.role}:${session?.driver || "dispatch"}`;
  if (soundedScope !== scope) {
    soundedScope = scope;
    try { soundedEvents = new Set(JSON.parse(localStorage.getItem(scope) || "[]")); }
    catch { soundedEvents = new Set(); }
  }
  for (const item of notices) {
    if (soundedEvents.has(item.id) || !playNotificationSound(item.kind)) continue;
    soundedEvents.add(item.id);
    try {
      if (window.Notification?.permission === "granted") new window.Notification(notificationTitle(item.kind), {
        body: "Open Dispatch to review your trip notifications.", tag: item.id, silent: true
      });
    } catch { /* The saved inbox remains available if system notifications are unsupported. */ }
  }
  try { localStorage.setItem(scope, JSON.stringify([...soundedEvents].slice(-5000))); } catch {}
}

function updateNotificationView() {
  const driver = session?.role === "driver";
  $("notificationControls").hidden = driver;
  const button = $("newNotificationButton");
  button.hidden = !driver;
  button.className = unreadNotificationCount > 0 ? "danger" : "success";
  button.ariaExpanded = String(driverInboxOpen);
  button.ariaLabel = `New Notification: ${unreadNotificationCount} unread`;
  $("driverNotifications").hidden = driver && !driverInboxOpen;
}
function toggleDriverNotifications() {
  driverInboxOpen = !driverInboxOpen;
  updateNotificationView();
  if (driverInboxOpen && !window.nativeTripNotifications) enableNotificationSounds();
  refreshNotifications();
}

async function refreshNotifications() {
  if (!session || notificationRequest === session.token) return;
  const token = session.token;
  notificationRequest = token;
  try {
    const data = await api("/notifications");
    if (session?.token !== token) return;
    const notices = data.notifications || [];
    unreadNotificationCount = notices.length;
    updateNotificationView();
    announceNotifications(notices);
    $("notificationCount").textContent = notices.length;
    $("driverNotifications").innerHTML = notices.length ? notices.map(item =>
      `<div class="step ${item.kind === "assigned" ? "done" : "current"}"><b>${esc(notificationTitle(item.kind))}</b><br>${esc(item.actor || "")} ${esc(item.trip_label)} · ${esc(item.trip_id)} · ${esc(displayDate(item.created_at))}<br><button class="ghost" onclick="readNotification('${esc(item.id)}')">Mark as read</button></div>`
    ).join("") : '<p class="small">No unread notifications.</p>';
  } catch (error) {
    if (session?.token === token) $("driverNotifications").textContent = "Notifications unavailable. Retrying…";
  } finally { if (notificationRequest === token) notificationRequest = null; }
}
async function readNotification(id) {
  try { await api(`/notifications/${encodeURIComponent(id)}/read`, { method: "PATCH" }); await refreshNotifications(); }
  catch (error) { alert(error.message); }
}
async function cancelTrip(id) {
  if (session?.role !== "dispatch" || !confirm("Cancel this trip and notify its assigned drivers?")) return;
  return patchTrip(id, { action: "cancel" });
}

async function refreshDriverLocations() {
  if (session?.role !== "dispatch") return;
  const requestToken = session.token;
  try {
    const data = await api("/driver-locations");
    if (session?.role !== "dispatch" || session.token !== requestToken) return;
    const locations = data.locations || [];
    window.DriverFleetMap?.update(locations);
    $("driverLocations").innerHTML = locations.length ? locations.map((item) => {
      if (item.latitude == null) return `<div class="step current"><b>${esc(item.driver)}</b> · Offline · check-in waiting for required location</div>`;
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      const url = `https://maps.apple.com/?ll=${encodeURIComponent(`${latitude},${longitude}`)}&q=Driver%20Location`;
      return `<div class="step ${item.current ? "done" : "current"}">📍 <b>${esc(item.driver)}</b> · ${item.current ? "Live" : "Offline · last known (stale)"} · GPS ${esc(displayDate(item.recorded_at))} · received ${esc(displayDate(item.updated_at))}
        · accuracy ~${Math.round(Number(item.accuracy))} m
        · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">View in Apple Maps</a></div>`;
    }).join("") : '<div class="step">No drivers sharing a recent location.</div>';
  } catch (error) {
    if (session?.role !== "dispatch" || session.token !== requestToken) return;
    window.DriverFleetMap?.unavailable();
    $("driverLocations").textContent = "Driver locations unavailable.";
    console.error(error);
  }
}

function locationMessage(message) {
  $("locationStatus").textContent = message;
  $("shareLocation").textContent = sharingLocation ? "Check Out" : "Retry Location";
}

async function sendLocation() {
  if (nativeLocation() || !sharingLocation || sendingLocation || document.visibilityState === "hidden") return;
  sendingLocation = true;
  const locationToken = session?.token;
  try {
    if (!navigator.geolocation) throw new Error("Location is unavailable on this device.");
    const position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 10000
      }));
    if (!sharingLocation || session?.token !== locationToken) return;
    await api("/driver-location", { method: "POST", body: JSON.stringify({
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy, recordedAt: new Date(position.timestamp).toISOString()
    }) });
    if (!sharingLocation || session?.token !== locationToken) return;
    lastLocationUpdate = position.timestamp;
    locationOnline = true;
    locationMessage(`Online in browser · keep this screen open · location updated ${new Date().toLocaleTimeString()}`);
    render();
  } catch (error) {
    if (session?.token !== locationToken || !sharingLocation) return;
    locationOnline = false;
    locationMessage(`Offline · location unavailable: ${error.message}`);
    render();
  } finally { sendingLocation = false; }
}

function startLocationSharing() {
  if (session?.role !== "driver" || sharingLocation) return;
  if (window.webkit?.messageHandlers?.driverLocation) {
    sharingLocation = true;
    locationMessage("Starting background location…");
    window.webkit.messageHandlers.driverLocation.postMessage({
      action: "checkIn", token: session.token, driver: session.driver
    });
    return;
  }
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
  if (window.webkit?.messageHandlers?.driverLocation) {
    window.webkit.messageHandlers.driverLocation.postMessage({ action: "checkOut" });
  } else {
    api("/driver-location", { method: "DELETE" }).catch((error) => console.error(error));
  }
}

window.nativeLocationState = (online, message, recordedAt) => {
  if (session?.role !== "driver" || !sharingLocation) return;
  locationOnline = online === true;
  if (locationOnline) {
    lastLocationUpdate = recordedAt ? Date.parse(recordedAt) : Date.now();
    locationOnline = Number.isFinite(lastLocationUpdate) && Date.now() - lastLocationUpdate < 60000;
  }
  locationMessage(message || (locationOnline ? "Online · background location active" : "Offline · location unavailable"));
  render();
};

function toggleLocationSharing() {
  if (sharingLocation) logout();
  else startLocationSharing();
}

document.addEventListener("visibilitychange", () => {
  if (sharingLocation && document.visibilityState === "visible") {
    if (nativeLocation()) nativeLocation().postMessage({ action: "refresh" });
    else sendLocation();
  }
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
  const url = `https://maps.apple.com/?daddr=${encodeURIComponent(address)}&dirflg=d`;
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(address)} in Apple Maps">${esc(address)}</a>${location?.room ? `, ${esc(location.room)}` : ""}`;
}

async function createTrip() {
  if (session?.role !== "dispatch" || savingTrip) return;
  const editingId = editingTripId;
  const pickup = editingId ? { room: $("aPickEditRoom").value } : addressFields("aPick");
  const dropoff = editingId ? { room: $("aDropEditRoom").value } : addressFields("aDrop");
  const pickupAddress = editingId ? $("aPickEditAddress").value.trim() : addressText(pickup);
  const dropoffAddress = editingId ? $("aDropEditAddress").value.trim() : addressText(dropoff);
  const firstName = $("patientFirstName").value.trim();
  const lastName = $("patientLastName").value.trim();
  const required = [firstName, lastName, $("phone").value,
    ...(editingId ? [pickupAddress, dropoffAddress] : [pickup, dropoff].flatMap(({ number, street, city, state, zip }) => [number, street, city, state, zip]))];
  if (required.some((value) => !value.trim())) return alert("Patient first and last name, phone, and all address fields except suite/apartment are required.");
  if (!editingId && ![pickup, dropoff].every(({ state, zip }) => /^[A-Z]{2}$/.test(state) && /^\d{5}(-\d{4})?$/.test(zip)))
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
  for (const leg of (!editingId && $("isRT").value === "yes" ? ["a", "b"] : ["a"])) {
    if (!validTripDate($(`${leg}Date`).value)) return alert("Choose a valid trip date for each leg.");
    if ($(`${leg}TimeType`).value === "Scheduled" && !/^([01]\d|2[0-3]):[0-5]\d$/.test($(`${leg}Time`).value))
      return alert("Choose a pick up time or select Patient will call.");
  }
  const now = Date.now();
  const base = {
    patientFirstName: firstName, patientLastName: lastName, patient: `${firstName} ${lastName}`,
    phone: $("phone").value, weight: Number($("weight").value || 0), type: $("tripType").value,
    needsWheelchair: $("needsWheelchair").value, needsOxygen: $("needsOxygen").value,
    hasStairs, stairsCount, hasCompanion: $("hasCompanion").value,
    twoMen: $("twoMen").value, needsHelper: $("needsHelper").value,
    helperDriver: $("needsHelper").value === "Yes" ? $("helperDriver").value : "",
    payment: $("payment").value, payStatus: $("payStatus").value, patientPays,
    payerType, payerFirstName, payerLastName, payerRelationship, payerPhone: patientPays === "Yes" ? $("payerPhone").value.trim() : "", paymentByPhone,
    patientAmount: patientPays === "Yes" ? Number($("patientAmount").value || 0) : 0, paymentCollected: patientPays === "Yes" && $("payStatus").value === "Paid",
    collectedBy: patientPays === "Yes" && $("payStatus").value === "Paid" ? "Dispatch" : "",
    collectedAt: patientPays === "Yes" && $("payStatus").value === "Paid" ? new Date().toISOString() : "",
    auth: $("auth").value, notes: $("notes").value, dispatchNotes: $("dispatchNotes").value, created: now
  };
  const group = `${$("isRT").value === "yes" ? "RT" : "OW"}-${now}`;
  const newTrips = [{ ...base, id: `A-${now}`, group, leg: "A", label: $("isRT").value === "yes" ? "Pick Up" : "One Way", tripDate: $("aDate").value, time: $("aTimeType").value === "Will Call" ? "" : $("aTime").value, timeType: $("aTimeType").value, driver: $("aDriver").value,
    pickup: loc($("aPickType").value, pickupAddress, pickup.room),
    dropoff: loc($("aDropType").value, dropoffAddress, dropoff.room), status: 0, events: [] }];
  if (!editingId && $("isRT").value === "yes") newTrips.push({ ...base, id: `B-${now + 1}`, group, leg: "B", label: "Return", returnPending: true, tripDate: $("bDate").value, time: $("bTimeType").value === "Will Call" ? "" : $("bTime").value,
    timeType: $("bTimeType").value, driver: $("bDriver").value,
    pickup: loc($("aDropType").value, dropoffAddress, dropoff.room),
    dropoff: loc($("aPickType").value, pickupAddress, pickup.room), status: 0, events: [] });
  try {
    setSync("", "Saving…");
    savingTrip = true;
    $("saveTripButton").disabled = true;
    if (editingId) {
      await api(`/trips/${encodeURIComponent(editingId)}`, { method: "PATCH", body: JSON.stringify({ action: "edit", trip: newTrips[0] }) });
      cancelTripEdit();
      await refreshTrips();
      alert("Trip updated. Only this leg was changed.");
    } else {
      await api("/trips", { method: "POST", body: JSON.stringify({ trips: newTrips }) });
      createTripOpen = false;
      updateTripFormVisibility();
      await refreshTrips();
      alert($("isRT").value === "yes" ? "Pick Up shared with the driver. Return saved separately in Pending Returns." : "Trip saved and shared with the assigned driver.");
    }
  } catch (error) { setSync("offline", "Save failed"); alert(error.message); }
  finally { savingTrip = false; $("saveTripButton").disabled = false; }
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

function isPendingReturn(trip) {
  return !trip.cancelled && trip.returnPending === true && trip.leg === "B" && String(trip.group || "").startsWith("RT-");
}

function validTripDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0, 4) !== "0000" &&
    Number.isFinite(Date.parse(value + "T12:00:00Z")) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
}
function tripDateLabel(value) {
  return validTripDate(value) ? new Date(value + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
  }) : "Date not set";
}
function compareTripSchedule(a, b) {
  const date = (validTripDate(a.tripDate) ? a.tripDate : "9999-99-99").localeCompare(validTripDate(b.tripDate) ? b.tripDate : "9999-99-99");
  const time = trip => trip.timeType === "Will Call" || !trip.time ? "99:99" : trip.time;
  return date || time(a).localeCompare(time(b)) || String(a.id).localeCompare(String(b.id));
}

function tripAdvanceBlock(trip) {
  if (Number(trip.status || 0) === 0) {
    const assigned = [trip.driver, trip.helperDriver].filter(name => name && name !== "Unassigned");
    const current = trips.find(other => other.id !== trip.id && !other.cancelled && !isPendingReturn(other) &&
      Number(other.status) >= 1 && Number(other.status) < 5 &&
      [other.driver, other.helperDriver].some(name => assigned.includes(name)));
    if (current) return "Mark the patient dropped off and complete the current trip before accepting this trip.";
  }
  const outboundRT = trip.leg === "A" && String(trip.group || "").startsWith("RT-");
  if (!outboundRT && Number(trip.status) === 4 && trip.patientPays === "Yes" && !trip.paymentCollected)
    return "Record the required payment before completing this trip.";
  return "";
}

function tripCard(t, mode) {
  const pendingReturn = isPendingReturn(t);
  const advanceBlock = mode === "driver" ? tripAdvanceBlock(t) : "";
  const destinationLocked = mode === "driver" && (t.destinationLocked === true || !(Number(t.status) >= 2));
  const status = t.cancelled ? "Cancelled" : pendingReturn ? "Pending Return" : steps[Number(t.status || 0)] || steps[0];
  const roundTrip = String(t.group || "").startsWith("RT-");
  const tripLabel = roundTrip ? (t.leg === "B" ? "Return" : "Pick Up") : "One Way";
  const needsWheelchair = t.needsWheelchair === "Yes" || (t.needsWheelchair == null && ["Wheelchair", "Bariatric Wheelchair"].includes(t.type));
  const needsOxygen = t.needsOxygen === "Yes";
  const stairs = t.hasStairs === "Yes" ? `YES — ${Number(t.stairsCount) > 0 ? `${Number(t.stairsCount)} steps` : "count not specified"}` : t.hasStairs === "No" ? "NO" : "Not specified";
  const companion = t.hasCompanion === "Yes" ? "YES" : t.hasCompanion === "No" ? "NO" : "Not specified";
  const payerName = [t.payerFirstName, t.payerLastName].filter(Boolean).join(" ") || "Not specified";
  const phonePayment = t.paymentByPhone === "Yes" ? "YES" : t.paymentByPhone === "No" ? "NO" : "Not specified";
  const dialLink = phoneDialLink(t.phone);
  const payerDialLink = phoneDialLink(t.payerPhone);
  const options = [...drivers, "Unassigned"].map((name) => `<option ${name === t.driver ? "selected" : ""}>${esc(name)}</option>`).join("");
  const helperOptions = [...drivers, "Unassigned"].map((name) => `<option ${name === t.helperDriver ? "selected" : ""}>${esc(name)}</option>`).join("");
  const next = Number(t.status) === 4 ? "Patient dropped off / Complete trip" : Number(t.status) < 5 ? steps[Number(t.status) + 1] : "Completed";
  return `<div class="card trip ${t.leg === "B" ? "return" : ""}">
    <div class="topline"><h3>${tripLabel}</h3>${mode === "dispatch" ? `<span class="badge ${roundTrip ? "rt" : ""}">${roundTrip ? "R/T" : "One Way"}</span>` : ""}</div>
    <div class="step"><b>📅 ${esc(tripDateLabel(t.tripDate))}</b> · ${esc(t.timeType === "Will Call" || !t.time ? "Patient will call" : t.time)}</div>
    <div><b>${esc(t.timeType === "Will Call" || !t.time ? "Patient will call" : t.time)} · ${esc(t.patient)}</b> · ${esc(t.type)} ${t.twoMen === "Yes" ? "· Two-Men Team" : ""}${t.needsHelper === "Yes" ? " · Helper Required" : ""}</div>
    <div class="step ${needsWheelchair || needsOxygen ? "current" : ""}">♿ Need Wheelchair: <b>${needsWheelchair ? "YES" : "NO"}</b><br>Need Oxygen: <b>${needsOxygen ? "YES" : "NO"}</b></div>
    <div class="step ${t.hasStairs === "Yes" ? "current" : ""}">Stairs: <b>${stairs}</b></div>
    <div class="step ${t.hasCompanion === "Yes" ? "current" : ""}">Companion: <b>${companion}</b></div>
    ${t.needsHelper === "Yes" ? `<div class="meta">🧑‍🤝‍🧑 <b>Helper Driver:</b> ${esc(t.helperDriver || "Unassigned")}</div>` : ""}
    <div class="meta">📞 <b>${esc(t.phone || "No phone")}</b>${t.weight ? ` · ⚖️ <b>${Number(t.weight)} lbs</b>` : ""}<br>📍 ${esc(t.pickup?.type)} — ${addressLink(t.pickup)}<br>🏁 ${destinationLocked ? "Destination hidden until you mark Arrived at Pickup." : `${esc(t.dropoff?.type)} — ${addressLink(t.dropoff)}`}<br>💳 ${esc(t.payment)} · ${esc(t.payStatus)}<br>${t.patientPays === "Yes" ? `💵 <b>Private Payment Due: $${Number(t.patientAmount || 0).toFixed(2)}</b>` : "💵 Private Payment Due: NO"}</div>
    ${t.payerType === "NoPay" ? `<div class="step">No Pay</div>` : t.patientPays === "Yes" ? `<div class="step current">${t.payerType === "Patient" ? "Patient Pays" : t.payerType === "Other" ? "Another Person Pays" : "Payer"}: <b>${esc(payerName)}</b><br>Relationship to Patient: <b>${esc(t.payerRelationship || "Not specified")}</b><br>Payer Phone: <b>${esc(t.payerPhone || "Not specified")}</b><br>Payment by Phone: <b>${phonePayment}</b></div>` : ""}
    ${mode === "dispatch" ? `<label>Driver — change independently</label><select onchange="changeDriver('${esc(t.id)}',this.value)">${options}</select>${t.needsHelper === "Yes" ? `<label>Helper Driver — change independently</label><select onchange="changeHelper('${esc(t.id)}',this.value)">${helperOptions}</select>` : ""}` : `<div class="step current">${esc(status)}</div>`}
    ${mode === "dispatch" ? `<div class="step"><b>Dispatch Notes — Private</b><div style="white-space:pre-wrap">${esc(t.dispatchNotes || "No private notes.")}</div></div>` : ""}
    ${mode === "dispatch" ? `<div class="actions">${!t.cancelled ? `<button class="danger" onclick="cancelTrip('${esc(t.id)}')">CANCEL TRIP</button>` : ""}<button class="ghost" ${t.cancelled ? "disabled" : ""} onclick="editTrip('${esc(t.id)}')">EDIT TRIP</button><button class="danger" onclick="deleteTrip('${esc(t.id)}')">DELETE TRIP</button></div>` : ""}
    ${mode === "dispatch" && pendingReturn ? `<div class="actions"><button class="primary" onclick="releaseReturn('${esc(t.id)}')" ${drivers.includes(t.driver) ? "" : "disabled"}>DISPATCH RETURN</button></div><p class="small">${drivers.includes(t.driver) ? "Held in Pending Returns until you dispatch it." : "Assign a driver to dispatch this return."}</p>` : ""}
    ${mode === "driver" && dialLink ? `<div class="actions"><a class="ghost call-patient" href="${esc(dialLink)}" aria-label="Call ${esc(t.patient || "patient")}">📞 CALL PATIENT</a></div>` : ""}
    ${mode === "driver" && t.patientPays === "Yes" && payerDialLink ? `<div class="actions"><a class="ghost call-payer" href="${esc(payerDialLink)}" aria-label="Call payer ${esc(payerName)}">📞 CALL PAYER</a></div>` : ""}
    ${mode === "driver" && t.patientPays === "Yes" ? (t.paymentCollected ? `<div class="step done">✓ PAYMENT COLLECTED — $${Number(t.patientAmount || 0).toFixed(2)}<br><span class="small">Collected by ${esc(t.collectedBy)} · ${esc(displayDate(t.collectedAt))}</span></div>` : `<div class="actions"><select id="paymentMethod-${esc(t.id)}" aria-label="Payment method"><option value="">Select payment method</option><option>Cash</option><option>Check</option><option>Credit Card</option></select><button class="success" onclick="collectPayment('${esc(t.id)}')" ${locationOnline ? "" : "disabled"}>RECORD PAYMENT — ${Number(t.patientAmount || 0).toFixed(2)}</button></div>`) : ""}
    ${mode === "driver" && Number(t.status) < 5 ? `<div class="actions"><button class="${Number(t.status) === 0 ? "success" : "primary"}" onclick="advance('${esc(t.id)}')" ${locationOnline && !advanceBlock ? "" : "disabled"}>${Number(t.status) === 0 ? "ACCEPT TRIP" : esc(next.toUpperCase())}</button></div>` : ""}
    ${advanceBlock ? `<div class="step current">${esc(advanceBlock)}</div>` : ""}
    ${mode === "driver" && Number(t.status) === 5 ? `<div class="step done">✓ Trip Completed</div>` : ""}
    ${mode === "dispatch" ? `<div class="step ${Number(t.status) === 5 ? "done" : "current"}">${esc(status)}</div>${t.patientPays === "Yes" ? (t.paymentCollected ? `<div class="step done">✓ Payment Collected: $${Number(t.patientAmount || 0).toFixed(2)} · ${esc(t.collectedBy)} · ${esc(displayDate(t.collectedAt))}</div>` : `<div class="step current">Payment Due: $${Number(t.patientAmount || 0).toFixed(2)} — Not Collected</div>`) : ""}` : ""}
  </div>`;
}

async function patchTrip(id, body) {
  try { setSync("", "Saving…"); await api(`/trips/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }); await refreshTrips(); }
  catch (error) { setSync("offline", "Save failed"); alert(error.message); }
}

const billingFormFields = ["payment", "payerType", "patientAmount", "paymentByPhone", "payerFirstName", "payerLastName", "payerRelationship", "payerPhone"];

function setFormValue(id, value) {
  const field = $(id);
  const text = String(value ?? "");
  if (field.tagName === "SELECT" && ![...field.options].some(option => option.value === text)) {
    field.add(new Option(text || "Not specified", text));
  }
  field.value = text;
}

function editTrip(id) {
  if (session?.role !== "dispatch" || savingTrip) return;
  const trip = trips.find(item => item.id === id);
  if (!trip) return;
  if (editingTripId && !confirm("Discard the current edit and open this trip?")) return;
  if (!tripFormSnapshot) tripFormSnapshot = [...$("tripForm").querySelectorAll("input, select, textarea")].map(field => ({ id: field.id, value: field.value, disabled: field.disabled }));
  editingTripId = id;
  const nameParts = String(trip.patient || "").trim().split(/\s+/);
  const fields = {
    patientFirstName: trip.patientFirstName || nameParts[0] || "",
    patientLastName: trip.patientLastName || nameParts.slice(1).join(" "),
    phone: trip.phone, weight: trip.weight, tripType: trip.type,
    needsWheelchair: trip.needsWheelchair || (["Wheelchair", "Bariatric Wheelchair"].includes(trip.type) ? "Yes" : "No"),
    needsOxygen: trip.needsOxygen || "No", hasCompanion: trip.hasCompanion || "No",
    hasStairs: trip.hasStairs || "No", stairsCount: trip.stairsCount || "",
    isRT: String(trip.group || "").startsWith("RT-") ? "yes" : "no", twoMen: trip.twoMen || "No", needsHelper: trip.needsHelper || "No",
    helperDriver: trip.helperDriver || "Unassigned",
    aDate: trip.tripDate || "",
    aTimeType: trip.timeType === "Will Call" || !trip.time ? "Will Call" : "Scheduled", aTime: trip.time || "",
    aDriver: trip.driver || "Unassigned", aPickType: trip.pickup?.type || "Other", aDropType: trip.dropoff?.type || "Other",
    aPickEditAddress: trip.pickup?.address, aPickEditRoom: trip.pickup?.room,
    aDropEditAddress: trip.dropoff?.address, aDropEditRoom: trip.dropoff?.room,
    payment: trip.payment, payStatus: trip.payStatus || "Pending",
    payerType: trip.payerType || (trip.patientPays === "Yes" ? "Patient" : "NoPay"),
    patientAmount: trip.patientAmount || 0, paymentByPhone: trip.paymentByPhone || "No",
    payerFirstName: trip.payerFirstName, payerLastName: trip.payerLastName, payerRelationship: trip.payerRelationship, payerPhone: trip.payerPhone,
    auth: trip.auth, notes: trip.notes, dispatchNotes: trip.dispatchNotes || ""
  };
  Object.entries(fields).forEach(([field, value]) => setFormValue(field, value));
  $("isRT").disabled = true;
  $("payStatus").disabled = true;
  billingFormFields.forEach(field => { $(field).disabled = trip.paymentCollected === true; });
  syncTripForm();
  $("tripFormTitle").textContent = `Edit ${trip.leg === "B" ? "Return" : String(trip.group || "").startsWith("RT-") ? "Pick Up" : "Trip"}`;
  $("outboundHeading").textContent = trip.leg === "B" ? "Return" : "Pick Up";
  $("saveTripButton").textContent = "Save Changes";
  $("cancelEditButton").classList.remove("hidden");
  for (const leg of ["aPick", "aDrop"]) {
    $(`${leg}CreateAddress`).classList.add("hidden");
    $(`${leg}EditWrap`).classList.remove("hidden");
  }
  $("tripForm").scrollIntoView({ behavior: "smooth", block: "start" });
  $("patientFirstName").focus({ preventScroll: true });
}

function openCreateTrip() {
  if (session?.role !== "dispatch" || savingTrip) return;
  if (editingTripId) {
    if (!confirm("Discard the current edit and open Create Trip?")) return;
    cancelTripEdit();
  }
  createTripOpen = true;
  updateTripFormVisibility();
  $("tripForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeTripForm() {
  if (savingTrip) return;
  if (editingTripId) { cancelTripEdit(); return; }
  createTripOpen = false;
  updateTripFormVisibility();
  $("openCreateTripButton").focus();
}

function updateTripFormVisibility() {
  $("tripForm").hidden = !editingTripId && !createTripOpen;
  $("openCreateTripButton").ariaExpanded = String(createTripOpen && !editingTripId);
}

function syncTripForm() {
  updateTripFormVisibility();
  updateTripService(); updatePickupTime("a"); updatePickupTime("b"); updatePayerFields();
  $("helperDriverWrap").classList.toggle("hidden", $("needsHelper").value !== "Yes");
  $("stairsCountWrap").classList.toggle("hidden", $("hasStairs").value !== "Yes");
}

function cancelTripEdit() {
  editingTripId = null;
  createTripOpen = false;
  if (tripFormSnapshot) for (const field of tripFormSnapshot) {
    $(field.id).value = field.value; $(field.id).disabled = field.disabled;
  }
  tripFormSnapshot = null;
  $("tripFormTitle").textContent = "Create Trip";
  $("saveTripButton").textContent = "Create Trip";
  $("cancelEditButton").classList.add("hidden");
  for (const leg of ["aPick", "aDrop"]) {
    $(`${leg}CreateAddress`).classList.remove("hidden");
    $(`${leg}EditWrap`).classList.add("hidden");
  }
  syncTripForm();
}

async function deleteTrip(id) {
  if (session?.role !== "dispatch" || savingTrip) return;
  const trip = trips.find(item => item.id === id);
  if (!trip || !confirm(`Delete ${trip.leg === "B" ? "Return" : "Pick Up"} for ${trip.patient}? Only this trip leg will be deleted. This cannot be undone.`)) return;
  try {
    setSync("", "Deleting…");
    await api(`/trips/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (editingTripId === id) cancelTripEdit();
    await refreshTrips();
  } catch (error) { setSync("offline", "Delete failed"); alert(error.message); }
}

function releaseReturn(id) { return patchTrip(id, { action: "releaseReturn" }); }
function changeDriver(id, driver) { return patchTrip(id, { driver }); }
function changeHelper(id, helperDriver) { return patchTrip(id, { helperDriver }); }
function advance(id) {
  if (!locationOnline) return alert("Go online and allow location access before updating a trip.");
  const trip = trips.find(item => item.id === id);
  if (!trip) return;
  const blocked = tripAdvanceBlock(trip);
  if (blocked) return alert(blocked);
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
function todayTripDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function folderForTrip(trip, day = todayTripDate()) {
  if (!validTripDate(trip.tripDate)) return "undated";
  return trip.tripDate < day ? "past" : trip.tripDate > day ? "upcoming" : "today";
}
function selectTripFolder(folder) {
  if (session?.role === "driver") return;
  if (!["today", "pending", "upcoming", "past", "undated"].includes(folder)) return;
  tripFolder = folder;
  render();
}
function render() {
  updateTripFormVisibility();
  if (session?.role === "driver") {
    const available = trips.filter(trip => !trip.cancelled && !isPendingReturn(trip) && Number(trip.status || 0) < 5).sort(compareTripSchedule);
    const current = available.filter(trip => Number(trip.status || 0) > 0);
    const upcoming = available.filter(trip => Number(trip.status || 0) === 0);
    $("tripFolderNav").innerHTML = `<span class="badge">Current (${current.length})</span><span class="badge">Upcoming (${upcoming.length})</span>`;
    $("tripFolderSummary").textContent = "Only your current and upcoming trips are shown. Completed trips are kept by Dispatch.";
    $("olderActiveTrips").innerHTML = "";
    $("driverTrips").innerHTML = `<h2>Current Trip</h2>${current.length ? current.map(trip => tripCard(trip, "driver")).join("") : '<div class="card">No trip in progress.</div>'}<h2>Upcoming Trips</h2>${upcoming.length ? upcoming.map(trip => tripCard(trip, "driver")).join("") : '<div class="card">No upcoming trips.</div>'}`;
    return;
  }
  const day = todayTripDate();
  const folders = { today: "Today", pending: "Pending", upcoming: "Upcoming", past: "Past Trips", undated: "Date Not Set" };
  const matchesFolder = (trip, folder) => folder === "pending" ? !trip.cancelled && isPendingReturn(trip) : folderForTrip(trip, day) === folder;
  $("tripFolderNav").innerHTML = Object.entries(folders).map(([key, label]) => `<button class="${tripFolder === key ? "primary" : "ghost"}" aria-pressed="${tripFolder === key}" onclick="selectTripFolder('${key}')">${label} (${trips.filter(trip => matchesFolder(trip, key)).length})</button>`).join("");
  $("tripFolderSummary").textContent = tripFolder === "pending" ? "All pending returns, across every date. Select Dispatch Return when ready to send one to the driver." : `${folders[tripFolder]} · Today is ${tripDateLabel(day)} (Eastern Time). Past trips are saved here automatically; nothing is deleted.`;
  const olderActive = trips.filter(trip => !trip.cancelled && Number(trip.status) >= 1 && Number(trip.status) < 5 && ["past", "undated"].includes(folderForTrip(trip, day)));
  $("olderActiveTrips").innerHTML = olderActive.length ? `<div class="step current">${olderActive.length} unfinished trip(s) in Past Trips / Date Not Set. Complete or ask Dispatch to cancel them before accepting another trip.</div>` : "";
  const scheduledTrips = trips.filter(trip => matchesFolder(trip, tripFolder)).sort(compareTripSchedule);
  const pendingReturns = scheduledTrips.filter(isPendingReturn);
  const dispatchedTrips = scheduledTrips.filter((trip) => !isPendingReturn(trip));
  $("pendingReturnTrips").innerHTML = pendingReturns.length ? pendingReturns.map((trip) => tripCard(trip, "dispatch")).join("") : `<div class="card">No pending returns.</div>`;
  $("pendingReturnCount").textContent = pendingReturns.length;
  $("kPendingReturns").textContent = pendingReturns.length;
  $("dispatchTrips").hidden = tripFolder === "pending";
  $("dispatchedTripsHeading").hidden = tripFolder === "pending";
  $("dispatchTrips").innerHTML = dispatchedTrips.length ? dispatchedTrips.map((trip) => tripCard(trip, "dispatch")).join("") : `<div class="card">No dispatched trips.</div>`;
  $("driverTrips").innerHTML = dispatchedTrips.filter(trip => !trip.cancelled).length ? dispatchedTrips.filter(trip => !trip.cancelled).map((trip) => tripCard(trip, "driver")).join("") : `<div class="card">No trips assigned to ${esc(session?.driver || "this driver")}.</div>`;
  $("kTotal").textContent = scheduledTrips.length;
  $("kScheduled").textContent = dispatchedTrips.filter((trip) => !trip.cancelled && Number(trip.status) < 1).length;
  $("kProgress").textContent = scheduledTrips.filter((trip) => !trip.cancelled && Number(trip.status) > 0 && Number(trip.status) < 5).length;
  $("kDone").textContent = scheduledTrips.filter((trip) => !trip.cancelled && Number(trip.status) === 5).length;
}

function updatePickupTime(leg) {
  const willCall = $(`${leg}TimeType`).value === "Will Call";
  $(`${leg}TimeWrap`).classList.toggle("hidden", willCall);
  $(`${leg}Time`).disabled = willCall;
}
for (const leg of ["a", "b"]) {
  $(`${leg}TimeType`).addEventListener("change", () => updatePickupTime(leg));
  updatePickupTime(leg);
}

const todayDate = todayTripDate();
$("aDate").value = todayDate;
$("bDate").value = todayDate;
let previousPickupDate = todayDate;
$("aDate").addEventListener("change", () => {
  if (!editingTripId && $("bDate").value === previousPickupDate) $("bDate").value = $("aDate").value;
  previousPickupDate = $("aDate").value;
});

function updateTripService() {
  const oneWay = $("isRT").value === "no";
  $("returnFields").classList.toggle("hidden", oneWay || Boolean(editingTripId));
  $("returnDriverWrap").classList.toggle("hidden", oneWay || Boolean(editingTripId));
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
  $("payerPhoneWrap").classList.toggle("hidden", noPay);
  $("payerNameFields").classList.toggle("hidden", $("payerType").value !== "Other");
}
$("payerType").addEventListener("change", updatePayerFields);
updatePayerFields();
$("hasStairs").addEventListener("change", () => $("stairsCountWrap").classList.toggle("hidden", $("hasStairs").value !== "Yes"));
$("tripType").addEventListener("change", () => { $("needsWheelchair").value = ["Wheelchair", "Bariatric Wheelchair"].includes($("tripType").value) ? "Yes" : "No"; });
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
