'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const pg = require('pg');

// Exercise production HTTP handlers and SQL against an isolated PostgreSQL engine.
// PGlite has one connection; concurrent multi-connection lock scheduling needs real PG.
test('Dispatch trip CRUD, pending R/T returns, pickup times and driver location', async () => {
  const db = new PGlite();
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  pg.Pool = class { query = query; async connect() { return { query, release() {} }; } };
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://test', JWT_SECRET: 'isolated-test-secret', DISPATCH_ACCESS_CODE: 'dispatch-test',
    DRIVER_NAMES: 'Test Driver', DRIVER_ACCESS_CODES: '{"Test Driver":"1234"}', PORT: '0', PGSSL: 'disable'
  });
  const server = await require('../server').start();
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, token, method = 'GET', body) {
    const response = await fetch(url + path, { signal: AbortSignal.timeout(10000), method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const login = async () => (await request('/login', null, 'POST', { role: 'driver', driver: 'Test Driver', code: '1234' })).data.token;
  const fix = () => ({ latitude: 40.1, longitude: -73.9, accuracy: 8, recordedAt: new Date().toISOString() });
  try {
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.version, 'driver-location-v1');
    const dispatch = (await request('/login', null, 'POST', { role: 'dispatch', code: 'dispatch-test' })).data.token;
    const tripInput = { id: 'pickup-time-test', patient: 'Test Patient', pickup: { address: 'Test pickup' }, dropoff: { address: 'Test dropoff' }, timeType: 'Scheduled', time: '09:15' };
    let saved = await request('/trips', dispatch, 'POST', { trips: [tripInput] });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.trips[0].time, '09:15');
    saved = await request('/trips', dispatch, 'POST', { trips: [{ ...tripInput, timeType: 'Will Call' }] });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.trips[0].time, '');
    assert.equal(saved.data.trips[0].timeType, 'Will Call');
    assert.equal((await request('/trips', dispatch, 'POST', { trips: [{ ...tripInput, time: '' }] })).status, 400);
    const first = await login();
    assert.equal((await request('/driver-locations')).status, 401);
    assert.equal((await request('/driver-locations', first)).status, 403);
    let list = (await request('/driver-locations', dispatch)).data.locations;
    assert.equal(list.length, 1);
    assert.equal(list[0].latitude, null);
    await query("INSERT INTO trips (id,data) VALUES ($1,$2)", ['trip', { id: 'trip', driver: 'Test Driver', status: 0 }]);
    assert.equal((await request('/trips/trip', first, 'PATCH', { action: 'advance' })).status, 409);
    assert.equal((await request('/trips/trip', first, 'PATCH', { action: 'collectPayment' })).status, 409);
    assert.equal((await request('/driver-location', dispatch, 'POST', fix())).status, 403);
    for (const invalid of [ { ...fix(), latitude: null }, { ...fix(), latitude: 91 },
      { ...fix(), recordedAt: new Date(Date.now() - 120000).toISOString() }, { ...fix(), accuracy: -1 } ]) {
      assert.equal((await request('/driver-location', first, 'POST', invalid)).status, 400);
    }
    assert.equal((await request('/driver-location', first, 'POST', fix())).status, 200);
    list = (await request('/driver-locations', dispatch)).data.locations;
    assert.equal(list[0].current, true);
    assert.ok(list[0].recorded_at && list[0].updated_at);
    assert.equal((await request('/trips/trip', first, 'PATCH', { action: 'advance' })).status, 200);
    // A new R/T pair immediately sends only A to the driver; B waits for Dispatch.
    const pair = ['A', 'B'].map(leg => ({ ...tripInput, id: `pending-${leg}`, group: 'RT-pending-test', leg, driver: 'Test Driver', returnPending: false }));
    const createdPair = await request('/trips', dispatch, 'POST', { trips: pair });
    assert.equal(createdPair.status, 201);
    assert.equal(createdPair.data.trips[0].returnPending, false);
    assert.equal(createdPair.data.trips[1].returnPending, true);
    assert.equal((await request('/trips/pending-B', first, 'PATCH', { action: 'edit', trip: { notes: 'Driver edit' } })).status, 403);
    assert.equal((await request('/trips/pending-B', first, 'DELETE')).status, 403);
    const editPending = await request('/trips/pending-B', dispatch, 'PATCH', { action: 'edit', trip: {
      notes: 'Return only', timeType: 'Will Call', time: '10:00', id: 'wrong-id', group: 'OW-injected', leg: 'A',
      returnPending: false, status: 5, paymentCollected: true, collectedAt: 'injected'
    } });
    assert.equal(editPending.status, 200);
    assert.equal(editPending.data.trip.id, 'pending-B');
    assert.equal(editPending.data.trip.group, 'RT-pending-test');
    assert.equal(editPending.data.trip.leg, 'B');
    assert.equal(editPending.data.trip.returnPending, true);
    assert.equal(editPending.data.trip.status, 0);
    assert.equal(editPending.data.trip.paymentCollected, false);
    assert.equal(editPending.data.trip.notes, 'Return only');
    assert.equal(editPending.data.trip.time, '');
    assert.equal((await request('/trips/pending-B', dispatch, 'PATCH', { action: 'edit', trip: { pickup: { address: '' } } })).status, 400);
    assert.equal((await request('/trips', dispatch)).data.trips.find(t => t.id === 'pending-A').notes, '');
    let driverTrips = (await request('/trips', first)).data.trips;
    assert.ok(driverTrips.some(t => t.id === 'pending-A'));
    assert.ok(!driverTrips.some(t => t.id === 'pending-B'));
    assert.ok((await request('/trips', dispatch)).data.trips.some(t => t.id === 'pending-B' && t.returnPending));
    assert.equal((await request('/trips/pending-B', first, 'PATCH', { action: 'advance' })).status, 409);
    assert.equal((await request('/trips/pending-B', first, 'PATCH', { action: 'releaseReturn' })).status, 409);
    assert.equal((await request('/trips/pending-B', dispatch, 'PATCH', { action: 'advance' })).status, 409);
    await request('/trips/pending-B', dispatch, 'PATCH', { driver: 'Unassigned', helperDriver: 'Test Driver' });
    assert.ok(!(await request('/trips', first)).data.trips.some(t => t.id === 'pending-B'));
    assert.equal((await request('/trips/pending-B', dispatch, 'PATCH', { action: 'releaseReturn' })).status, 400);
    await request('/trips/pending-B', dispatch, 'PATCH', { driver: 'Test Driver' });
    const released = await request('/trips/pending-B', dispatch, 'PATCH', { action: 'releaseReturn' });
    assert.equal(released.status, 200);
    assert.equal(released.data.trip.returnPending, false);
    assert.equal(released.data.trip.status, 0);
    assert.equal((await request('/trips/pending-B', dispatch, 'PATCH', { action: 'releaseReturn' })).status, 409);
    driverTrips = (await request('/trips', first)).data.trips;
    assert.ok(driverTrips.some(t => t.id === 'pending-B'));
    assert.equal(driverTrips.find(t => t.id === 'pending-A').status, 0);
    assert.equal((await request('/trips/pending-B', first, 'PATCH', { action: 'advance' })).status, 200);
    assert.equal((await request('/trips/pending-A', dispatch, 'PATCH', { action: 'releaseReturn' })).status, 409);
    const editActive = await request('/trips/pending-B', dispatch, 'PATCH', { action: 'edit', trip: { notes: 'Still accepted', status: 0 } });
    assert.equal(editActive.data.trip.status, 1);
    assert.equal((await request('/trips/pending-B', dispatch, 'DELETE')).status, 200);
    assert.equal((await request('/trips/pending-B', dispatch, 'DELETE')).status, 404);
    const remaining = (await request('/trips', dispatch)).data.trips;
    assert.ok(!remaining.some(t => t.id === 'pending-B'));
    assert.ok(remaining.some(t => t.id === 'pending-A'));
    const paid = { ...tripInput, id: 'paid-trip', patientFirstName: 'Paid', patientLastName: 'Patient',
      payerType: 'Patient', patientPays: 'Yes', patientAmount: 75, paymentCollected: true, payStatus: 'Paid',
      collectedBy: 'Dispatch', collectedAt: new Date().toISOString(), paymentMethod: 'Cash' };
    assert.equal((await request('/trips', dispatch, 'POST', { trips: [paid] })).status, 201);
    const editedPaid = await request('/trips/paid-trip', dispatch, 'PATCH', { action: 'edit', trip: {
      notes: 'Updated after collection', payerType: 'NoPay', patientAmount: 0, paymentCollected: false, payStatus: 'Pending', collectedBy: 'other'
    } });
    assert.equal(editedPaid.status, 200);
    assert.equal(editedPaid.data.trip.notes, 'Updated after collection');
    assert.equal(editedPaid.data.trip.patientAmount, 75);
    assert.equal(editedPaid.data.trip.paymentCollected, true);
    assert.equal(editedPaid.data.trip.payStatus, 'Paid');
    assert.equal(editedPaid.data.trip.collectedBy, 'Dispatch');
    await query("UPDATE driver_locations SET recorded_at=NOW() - INTERVAL '2 minutes'");
    assert.equal((await request('/driver-locations', dispatch)).data.locations[0].current, false);
    assert.equal((await request('/trips/trip', first, 'PATCH', { action: 'advance' })).status, 409);
    assert.equal((await request('/driver-location', first, 'DELETE')).status, 200);
    assert.equal((await request('/driver-location', first, 'POST', fix())).status, 401);
    assert.equal((await request('/driver-locations', dispatch)).data.locations.length, 0);
    const second = await login();
    assert.equal((await request('/driver-location', second, 'POST', fix())).status, 200);
    await request('/driver-location', first, 'DELETE');
    assert.equal((await request('/driver-locations', dispatch)).data.locations[0].current, true);
    assert.equal((await request('/driver-location', first, 'POST', fix())).status, 401);
    const older = { ...fix(), latitude: 10, recordedAt: new Date(Date.now() - 30000).toISOString() };
    await request('/driver-location', second, 'POST', older);
    assert.equal((await request('/driver-locations', dispatch)).data.locations[0].latitude, 40.1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
