'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').split('function loc(type, address, room)')[0];
function setup(native = true) {
  const messages = [], requests = [], events = {};
  let geolocationCalls = 0;
  const context = vm.createContext({
    console, Date, JSON, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => JSON.stringify({ role: 'driver', token: 'test', driver: 'Test' }) },
    window: { isSecureContext: true, ...(native ? { webkit: { messageHandlers: { driverLocation: { postMessage: message => messages.push(message) } } } } : {}) },
    navigator: { geolocation: { getCurrentPosition: resolve => { geolocationCalls++; resolve({ timestamp: Date.now(), coords: { latitude: 40, longitude: -73, accuracy: 10 } }); } } },
    document: { visibilityState: 'visible', getElementById: () => ({}), addEventListener: (name, handler) => { events[name] = handler; } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({}) }; },
    render() {}
  });
  vm.runInContext(source, context);
  return { context, messages, requests, events, geolocationCalls: () => geolocationCalls };
}
test('native check-in and foreground refresh never start browser GPS; checkout stops bridge', async () => {
  const state = setup();
  vm.runInContext('startLocationSharing()', state.context);
  await vm.runInContext('sendLocation()', state.context);
  state.events.visibilitychange();
  assert.deepEqual(state.messages.map(x => x.action), ['checkIn', 'refresh']);
  assert.equal(state.geolocationCalls(), 0);
  assert.equal(vm.runInContext('locationOnline', state.context), false);
  vm.runInContext('window.nativeLocationState(true, "online")', state.context);
  assert.equal(vm.runInContext('locationOnline', state.context), true);
  vm.runInContext('stopLocationSharing()', state.context);
  assert.equal(state.messages.at(-1).action, 'checkOut');
  vm.runInContext('window.nativeLocationState(true, "late callback")', state.context);
  assert.equal(vm.runInContext('locationOnline', state.context), false);
});
test('browser uploads GPS acquisition time and checkout requests deletion', async () => {
  const state = setup(false);
  await vm.runInContext('sharingLocation = true; sendLocation()', state.context);
  const body = JSON.parse(state.requests[0].options.body);
  assert.ok(Number.isFinite(Date.parse(body.recordedAt)));
  assert.equal(body.latitude, 40);
  vm.runInContext('stopLocationSharing()', state.context);
  assert.equal(state.requests.at(-1).options.method, 'DELETE');
});

test('native refresh uses acquisition time and cannot make an old fix online', () => {
  const state = setup();
  vm.runInContext('startLocationSharing()', state.context);
  state.context.oldFix = new Date(Date.now() - 65000).toISOString();
  vm.runInContext('window.nativeLocationState(true, "online", oldFix)', state.context);
  assert.equal(vm.runInContext('locationOnline', state.context), false);
  state.context.freshFix = new Date().toISOString();
  vm.runInContext('window.nativeLocationState(true, "online", freshFix)', state.context);
  assert.equal(vm.runInContext('locationOnline', state.context), true);
});
