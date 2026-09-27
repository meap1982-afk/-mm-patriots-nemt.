"use strict";

// Keep coordinates in memory only. API access remains restricted to Dispatch.
window.DriverFleetMap = (() => {
  let map, markers, rows = [], fetchedAt = 0, timer, fitted = false;
  function isLive(item) {
    const age = Date.now() - Date.parse(item.recorded_at);
    return item.current === true && age >= -10000 && age < 60000 && Date.now() - fetchedAt < 60000;
  }
  function fit() {
    if (markers?.getLayers().length) map.fitBounds(markers.getBounds().pad(0.2), { maxZoom: 15 });
  }
  function draw() {
    if (!map) return;
    markers.clearLayers();
    let live = 0;
    for (const item of rows) {
      if (item.latitude == null || item.longitude == null) continue;
      const lat = Number(item.latitude), lng = Number(item.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const current = isLive(item);
      if (current) live++;
      const label = document.createElement('span');
      label.textContent = `${item.driver} · ${current ? 'Live' : 'Offline · last known'} · GPS ${new Date(item.recorded_at).toLocaleTimeString()} · ±${Math.round(Number(item.accuracy))} m`;
      window.L.circleMarker([lat, lng], { radius: 9, color: current ? '#08783b' : '#805b12', fillColor: current ? '#22c55e' : '#fbbf24', fillOpacity: 0.9, weight: 3 })
        .bindTooltip(label, { permanent: true, direction: 'top' }).addTo(markers);
    }
    document.getElementById('fleetMapStatus').textContent = `${live} online · ${rows.length - live} waiting or offline. Green: live. Amber: last known. Map refreshes every 5 seconds.`;
    map.invalidateSize();
    if (!fitted && markers.getLayers().length) { fit(); fitted = true; }
  }
  function update(locations) {
    if (!window.L) {
      document.getElementById('fleetMapStatus').textContent = 'Map unavailable. Use the driver map links below.';
      return;
    }
    if (!map) {
      map = window.L.map('fleetMap', { scrollWheelZoom: false }).setView([39, -98], 4);
      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        referrerPolicy: 'strict-origin-when-cross-origin'
      }).on('tileerror', () => {
        document.getElementById('fleetTileStatus').textContent = 'Basemap unavailable. Driver markers and map links are still available.';
      }).addTo(map);
      markers = window.L.featureGroup().addTo(map);
      timer = setInterval(draw, 5000);
    }
    rows = locations;
    fetchedAt = Date.now();
    draw();
  }
  function unavailable() {
    // A failed refresh must never leave a green marker claiming to be live.
    rows = rows.map(item => ({ ...item, current: false }));
    draw();
    document.getElementById('fleetMapStatus').textContent = 'Connection lost · locations are last known. Retrying…';
  }
  function clear() {
    clearInterval(timer);
    if (map) map.remove();
    map = markers = undefined;
    rows = []; fitted = false;
  }
  return { update, unavailable, clear, fit };
})();
