'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('inbox shows saved cancellation, acknowledges only the selected event, ignores an old session response', async () => {
  const elements = new Map();
  const requests = [];
  let response = [{ id: 'one', kind: 'cancelled', trip_id: '<deleted>', trip_label: 'Return', created_at: new Date().toISOString() }];
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    localStorage: { getItem: () => JSON.stringify({ role: 'driver', token: 'first' }) }, window: {}, console,
    fetch: async (url, options) => { requests.push({url, options}); return { ok: true, status: 200, json: async () => ({ notifications: response }) }; }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8').split('for (const leg of ["a", "b"])')[0], context);
  await vm.runInContext('refreshNotifications()', context);
  assert.match(elements.get('driverNotifications').innerHTML, /cancelled/);
  assert.match(elements.get('driverNotifications').innerHTML, /&lt;deleted&gt;/);
  assert.equal(elements.get('notificationCount').textContent, 1);
  response = [];
  await vm.runInContext('readNotification("one")', context);
  assert.ok(requests.some(r => r.url === '/api/notifications/one/read' && r.options.method === 'PATCH'));
  assert.equal(elements.get('notificationCount').textContent, 0);
  let resolve;
  context.fetch = () => new Promise(done => { resolve = done; });
  const pending = vm.runInContext('refreshNotifications()', context);
  vm.runInContext('session = {role: "driver", token: "second"}', context);
  resolve({ok: true, status: 200, json: async () => ({notifications: [{id:'old'}]})});
  await pending;
  assert.equal(elements.get('notificationCount').textContent, 0);
});


test('four distinct sound patterns, one alert per event, and no browser double sound in native driver', () => {
  const storage = new Map(), frequencies = [], systemAlerts = [];
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: () => ({}) },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value) },
    window: { Notification: class { static permission = 'granted'; constructor(title) {systemAlerts.push(title);} } }, console
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8').split('for (const leg of ["a", "b"])')[0], context);
  context.fakeAudio = { state:'running', currentTime:0, destination:{},
    createOscillator() { const oscillator = {frequency:{value:0},connect(){},start(){frequencies.push(oscillator.frequency.value);},stop(){}}; return oscillator; },
    createGain() {return { gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}
  };
  vm.runInContext('notificationAudio = fakeAudio; session = {role:"dispatch"};', context);
  vm.runInContext('announceNotifications([{id:"a",kind:"accepted"},{id:"b",kind:"dropped_off"}])', context);
  assert.deepEqual(frequencies, [880,1100,523,659,784,1047]);
  assert.equal(systemAlerts.length, 2);
  vm.runInContext('announceNotifications([{id:"a",kind:"accepted"},{id:"b",kind:"dropped_off"}])', context);
  assert.equal(frequencies.length, 6);
  vm.runInContext('soundedScope = ""; announceNotifications([{id:"a",kind:"accepted"}])', context);
  assert.equal(frequencies.length, 6); // Deduplicates after reloading saved IDs.
  vm.runInContext('session = {role:"driver",driver:"Test"}; announceNotifications([{id:"c",kind:"assigned"},{id:"d",kind:"cancelled"}])', context);
  assert.deepEqual(frequencies.slice(6), [660,880,1100,440,330,220]);
  vm.runInContext('window.nativeTripNotifications = true; announceNotifications([{id:"native",kind:"assigned"}])', context);
  assert.equal(frequencies.length, 12);
  vm.runInContext('window.nativeTripNotifications = false; notificationAudio.state="suspended"; announceNotifications([{id:"retry",kind:"assigned"}])', context);
  assert.equal(frequencies.length, 12);
  vm.runInContext('notificationAudio.state="running"; announceNotifications([{id:"retry",kind:"assigned"}])', context);
  assert.equal(frequencies.length, 15);
});
