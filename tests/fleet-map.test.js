'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('fleet map moves drivers, expires fixes, handles disconnection and clears checkout markers', () => {
  let now = Date.now(), tick, layers = [], fits = 0, removed = false;
  const elements = {};
  const map = { setView() { return this; }, invalidateSize() {}, fitBounds() { fits++; }, remove() { removed = true; } };
  const group = { addTo() { return this; }, clearLayers() { layers = []; }, getLayers: () => layers, getBounds: () => ({ pad() { return this; } }) };
  const context = vm.createContext({
    window: { L: {
      map: () => map, featureGroup: () => group,
      tileLayer: () => ({ on() { return this; }, addTo() {} }),
      circleMarker: (position, style) => ({ position, style,
        bindTooltip(label) { this.label = label; return this; }, addTo() { layers.push(this); return this; } })
    } },
    Date: class extends Date { static now() { return now; } },
    document: { createElement: () => ({}), getElementById: id => elements[id] ||= {} },
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../fleet-map.js'), 'utf8'), context);
  const fleet = context.window.DriverFleetMap;
  const driver = { driver: '<img src=x onerror=alert(1)>', latitude: 40, longitude: -73, accuracy: 8, current: true, recorded_at: new Date(now).toISOString() };
  fleet.update([driver, { driver: 'Waiting', latitude: null }]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].style.color, '#08783b');
  assert.ok(layers[0].label.textContent.startsWith(driver.driver)); // Names are text, never HTML.
  assert.match(elements.fleetMapStatus.textContent, /1 online/);
  fleet.update([{ ...driver, latitude: 41 }]);
  assert.equal(layers[0].position[0], 41);
  assert.equal(fits, 1); // Polling preserves dispatcher's zoom/pan.
  now += 61000;
  tick();
  assert.equal(layers[0].style.color, '#805b12');
  assert.match(elements.fleetMapStatus.textContent, /0 online/);
  fleet.update([{ ...driver, recorded_at: new Date(now).toISOString() }]);
  fleet.unavailable();
  assert.equal(layers[0].style.color, '#805b12');
  assert.match(elements.fleetMapStatus.textContent, /Connection lost/);
  fleet.update([]);
  assert.equal(layers.length, 0);
  fleet.clear();
  assert.equal(removed, true);
});
