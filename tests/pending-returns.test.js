'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('pending returns render separately and are withheld from the driver until dispatched', () => {
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
      addEventListener() {}
    },
    localStorage: { getItem: () => 'null' }, window: {}, console
  });
  const source = fs.readFileSync(require.resolve('../app.js'), 'utf8').split('for (const leg of ["a", "b"])')[0];
  vm.runInContext(source, context);
  vm.runInContext(`
    tripFolder = 'undated';
    drivers = ['Test Driver'];
    trips = [
      { id: 'a', group: 'RT-test', leg: 'A', patient: 'Outbound Patient', driver: 'Test Driver', status: 0 },
      { id: 'b', group: 'RT-test', leg: 'B', patient: 'Pending Patient', driver: 'Test Driver', status: 0, returnPending: true },
      { id: 'old', group: 'RT-old', leg: 'B', patient: 'Existing Return', status: 1 }
    ];
    render();
  `, context);
  assert.match(elements.get('pendingReturnTrips').innerHTML, /Pending Patient/);
  assert.match(elements.get('pendingReturnTrips').innerHTML, /DISPATCH RETURN/);
  assert.doesNotMatch(elements.get('dispatchTrips').innerHTML, /Pending Patient/);
  assert.doesNotMatch(elements.get('driverTrips').innerHTML, /Pending Patient/);
  assert.match(elements.get('dispatchTrips').innerHTML, /Outbound Patient/);
  assert.match(elements.get('dispatchTrips').innerHTML, /Existing Return/);
  assert.equal(elements.get('kPendingReturns').textContent, 1);
  assert.equal(elements.get('kScheduled').textContent, 1);
  vm.runInContext('trips[1].returnPending = false; render()', context);
  assert.equal(elements.get('kPendingReturns').textContent, 0);
  assert.equal(elements.get('kScheduled').textContent, 2);
  assert.match(elements.get('driverTrips').innerHTML, /Pending Patient/);
});
