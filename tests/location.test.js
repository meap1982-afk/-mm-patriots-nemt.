'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const pg = require('pg');

// Exercise production HTTP handlers and SQL against an isolated PostgreSQL engine.
// PGlite has one connection; concurrent multi-connection lock scheduling needs real PG.
test('required location, Dispatch visibility, checkout and replacement shifts', async () => {
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
