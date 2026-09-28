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
    const tripInput = { dispatchNotes: 'Private creation note', id: 'pickup-time-test', tripDate: '2026-09-26', patient: 'Test Patient', pickup: { address: 'Test pickup' }, dropoff: { address: 'Test dropoff' }, timeType: 'Scheduled', time: '09:15' };
    let saved = await request('/trips', dispatch, 'POST', { trips: [tripInput] });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.trips[0].time, '09:15');
    assert.equal(saved.data.trips[0].dispatchNotes, 'Private creation note');
    assert.equal(saved.data.trips[0].tripDate, '2026-09-26');
    for (const tripDate of ['', '2026-02-30', '2026-13-01', '2026-09-26extra']) {
      assert.equal((await request('/trips', dispatch, 'POST', { trips: [{...tripInput, tripDate}] })).status, 400);
    }
    const dates = [
      {...tripInput,id:'date-next',tripDate:'2026-09-28',time:'08:00'},
      {...tripInput,id:'date-late',tripDate:'2026-09-27',time:'15:00'},
      {...tripInput,id:'date-call',tripDate:'2026-09-27',timeType:'Will Call'},
      {...tripInput,id:'date-early',tripDate:'2026-09-27',time:'09:00'}
    ];
    for (const trip of dates) assert.equal((await request('/trips',dispatch,'POST',{trips:[trip]})).status,201);
    assert.deepEqual((await request('/trips',dispatch)).data.trips.filter(t=>t.id.startsWith('date-')).map(t=>t.id),['date-early','date-late','date-call','date-next']);
    assert.equal((await request('/trips/date-next',dispatch,'PATCH',{action:'edit',trip:{tripDate:'2026-02-30'}})).status,400);
    assert.equal((await request('/trips/date-next',dispatch,'PATCH',{action:'edit',trip:{tripDate:'2026-09-25'}})).data.trip.tripDate,'2026-09-25');

    saved = await request('/trips', dispatch, 'POST', { trips: [{ ...tripInput, timeType: 'Will Call' }] });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.trips[0].time, '');
    assert.equal(saved.data.trips[0].timeType, 'Will Call');
    assert.equal((await request('/trips', dispatch, 'POST', { trips: [{ ...tripInput, time: '' }] })).status, 400);
    const first = await login();
    assert.equal((await request('/notifications')).status, 401);
    assert.equal((await request('/notifications', dispatch)).status, 200);
    const inbox = async () => (await request('/notifications', first)).data.notifications;
    const eventTrip = { ...tripInput, id: 'notice-test', driver: 'Test Driver', helperDriver: 'Test Driver' };
    assert.equal((await request('/trips', dispatch, 'POST', { trips: [eventTrip] })).status, 201);
    let notices = (await inbox()).filter(n => n.trip_id === eventTrip.id);
    assert.equal(notices.length, 1); // Primary and helper are the same person.
    assert.equal(notices[0].kind, 'assigned');
    await request('/trips/notice-test', dispatch, 'PATCH', { driver: 'Test Driver' });
    assert.equal((await inbox()).filter(n => n.trip_id === eventTrip.id).length, 1);
    await request('/trips/notice-test', dispatch, 'PATCH', { driver: 'Unassigned', helperDriver: 'Unassigned' });
    assert.equal((await inbox()).filter(n => n.trip_id === eventTrip.id && n.kind === 'cancelled').length, 1);
    await request('/trips/notice-test', dispatch, 'PATCH', { driver: 'Test Driver' });
    assert.equal((await request('/trips/notice-test', first, 'PATCH', { action: 'cancel' })).status, 403);
    assert.equal((await request('/trips/notice-test', dispatch, 'PATCH', { action: 'cancel' })).status, 200);
    assert.ok(!(await request('/trips', first)).data.trips.some(t => t.id === eventTrip.id));
    assert.equal((await request('/trips/notice-test', first, 'PATCH', { action: 'advance' })).status, 409);
    notices = (await inbox()).filter(n => n.trip_id === eventTrip.id);
    assert.equal(notices.length, 4);
    await request('/trips/notice-test', dispatch, 'DELETE');
    assert.equal((await inbox()).filter(n => n.trip_id === eventTrip.id).length, 4);
    await request(`/notifications/${notices[0].id}/read`, first, 'PATCH');
    assert.ok(!(await inbox()).some(n => n.id === notices[0].id));
    await query("INSERT INTO driver_notifications (id,driver,trip_id,kind,trip_label) VALUES ('other-private','Another Driver','private','assigned','Pick Up')");
    assert.ok(!(await inbox()).some(n => n.id === 'other-private'));
    await request('/notifications/other-private/read', first, 'PATCH');
    assert.equal((await query("SELECT read_at FROM driver_notifications WHERE id='other-private'")).rows[0].read_at, null);

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
    for (let step = 0; step < 4; step++) assert.equal((await request('/trips/trip', first, 'PATCH', { action: 'advance' })).status, 200);
    // A new R/T pair immediately sends only A to the driver; B waits for Dispatch.
    const pair = ['A', 'B'].map(leg => ({ ...tripInput, id: `pending-${leg}`, group: 'RT-pending-test', leg, driver: 'Test Driver', returnPending: false }));
    const createdPair = await request('/trips', dispatch, 'POST', { trips: pair });
    assert.equal(createdPair.status, 201);
    assert.equal(createdPair.data.trips[0].returnPending, false);
    assert.equal(createdPair.data.trips[1].returnPending, true);
    assert.ok(!(await inbox()).some(n => n.trip_id === 'pending-B'));
    assert.equal((await request('/trips/pending-B', first, 'PATCH', { action: 'edit', trip: { notes: 'Driver edit' } })).status, 403);
    assert.equal((await request('/trips/pending-B', first, 'DELETE')).status, 403);
    const editPending = await request('/trips/pending-B', dispatch, 'PATCH', { action: 'edit', trip: {
      payerPhone: '+1 (555) 555-0456', notes: 'Return only', dispatchNotes: 'Private return note', timeType: 'Will Call', time: '10:00', id: 'wrong-id', group: 'OW-injected', leg: 'A',
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
    assert.equal(editPending.data.trip.dispatchNotes, 'Private return note');
    assert.equal((await request('/trips', dispatch)).data.trips.find(t=>t.id==='pending-A').dispatchNotes,'Private creation note');
    assert.equal(editPending.data.trip.payerPhone, '+1 (555) 555-0456');
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
    assert.equal((await inbox()).filter(n => n.trip_id === 'pending-B' && n.kind === 'assigned').length, 1);
    assert.equal(released.data.trip.status, 0);
    assert.equal((await request('/trips/pending-B', dispatch, 'PATCH', { action: 'releaseReturn' })).status, 409);
    driverTrips = (await request('/trips', first)).data.trips;
    assert.ok(driverTrips.some(t => t.id === 'pending-B'));
    assert.equal(driverTrips.find(t => t.id === 'pending-B').payerPhone, '+1 (555) 555-0456');
    assert.equal(driverTrips.find(t => t.id === 'pending-A').status, 0);
    const acceptedPrivate = await request('/trips/pending-B', first, 'PATCH', { action: 'advance', dispatchNotes: 'Injected' });
    assert.equal(acceptedPrivate.status, 200);
    assert.ok(!Object.hasOwn(acceptedPrivate.data.trip, 'dispatchNotes'));
    assert.equal((await request('/trips', dispatch)).data.trips.find(t=>t.id==='pending-B').dispatchNotes,'Private return note');
    assert.equal((await request('/trips/pending-B', first, 'PATCH', { action:'edit',trip:{dispatchNotes:'Injected'} })).status,403);
    // Both primary and helper drivers must never receive the field at any visible stage.
    for (const helper of [false,true]) {
      for (const status of [0,1,2,3,4]) {
        const privateTrip={...tripInput,id:'privacy-test',status,driver:helper?'Unassigned':'Test Driver',helperDriver:helper?'Test Driver':'',dispatchNotes:'Private secret'};
        await query('INSERT INTO trips (id,data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data',['privacy-test',privateTrip]);
        const visible=(await request('/trips',first)).data.trips.find(t=>t.id==='privacy-test');
        assert.ok(visible);
        assert.ok(!Object.hasOwn(visible,'dispatchNotes'));
      }
    }
    await query('DELETE FROM trips WHERE id=$1',['privacy-test']);
    let dispatchNotices = (await request('/notifications', dispatch)).data.notifications;
    const acceptance = dispatchNotices.find(n => n.trip_id === 'pending-B' && n.kind === 'accepted');
    assert.ok(acceptance);
    assert.equal(acceptance.actor, 'Test Driver');
    assert.ok(!(await inbox()).some(n => n.kind === 'accepted'));
    await request(`/notifications/${acceptance.id}/read`, first, 'PATCH');
    assert.ok((await request('/notifications', dispatch)).data.notifications.some(n => n.id === acceptance.id));
    assert.equal((await request('/trips/pending-A', dispatch, 'PATCH', { action: 'releaseReturn' })).status, 409);
    const editActive = await request('/trips/pending-B', dispatch, 'PATCH', { action: 'edit', trip: { notes: 'Still accepted', status: 0 } });
    assert.equal(editActive.data.trip.status, 1);
    assert.equal((await request('/trips/pending-B', dispatch, 'DELETE')).status, 200);
    assert.equal((await inbox()).filter(n => n.trip_id === 'pending-B' && n.kind === 'cancelled').length, 1);
    assert.equal((await request('/trips/pending-B', dispatch, 'DELETE')).status, 404);
    const remaining = (await request('/trips', dispatch)).data.trips;
    assert.ok(!remaining.some(t => t.id === 'pending-B'));
    assert.ok(remaining.some(t => t.id === 'pending-A'));
    assert.equal((await request('/trips', dispatch, 'POST', { trips: [{...tripInput, id: 'dropoff-test', driver: 'Test Driver'}] })).status, 201);
    const assignedView = (await request('/trips', first)).data.trips.find(t => t.id === 'dropoff-test');
    assert.equal(assignedView.dropoff, null);
    assert.equal(assignedView.destinationLocked, true);
    assert.equal((await request('/trips', dispatch)).data.trips.find(t => t.id === 'dropoff-test').dropoff.address, tripInput.dropoff.address);
    for (let status = 1; status <= 4; status++) {
      const advanced = await request('/trips/dropoff-test', first, 'PATCH', { action: 'advance' });
      assert.equal(advanced.status, 200);
      const listed = (await request('/trips', first)).data.trips.find(t => t.id === 'dropoff-test');
      for (const view of [advanced.data.trip, listed]) {
        if (status < 2) {
          assert.equal(view.dropoff, null);
          assert.equal(view.destinationLocked, true);
        } else {
          assert.equal(view.dropoff.address, tripInput.dropoff.address);
          assert.notEqual(view.destinationLocked, true);
        }
      }
    }
    assert.ok(!(await request('/notifications', dispatch)).data.notifications.some(n => n.trip_id === 'dropoff-test' && n.kind === 'dropped_off'));
    const completedTrip = await request('/trips/dropoff-test', first, 'PATCH', { action: 'advance' });
    assert.equal(completedTrip.status, 200);
    assert.equal(completedTrip.data.trip, null);
    assert.ok(!(await request('/trips', first)).data.trips.some(t => t.id === 'dropoff-test'));
    assert.equal((await request('/trips', dispatch)).data.trips.find(t => t.id === 'dropoff-test').status, 5);
    assert.equal((await request('/trips/dropoff-test', first, 'PATCH', { action: 'collectPayment', paymentMethod:'Cash' })).status, 400);
    await query("INSERT INTO trips (id,data) VALUES ($1,$2)", ['helper-completed', {...tripInput,id:'helper-completed',driver:'Unassigned',helperDriver:'Test Driver',status:5}]);
    assert.ok(!(await request('/trips', first)).data.trips.some(t => t.id === 'helper-completed'));

    assert.equal((await request('/trips/dropoff-test', first, 'PATCH', { action: 'advance' })).status, 400);
    dispatchNotices = (await request('/notifications', dispatch)).data.notifications.filter(n => n.trip_id === 'dropoff-test');
    assert.equal(dispatchNotices.filter(n => n.kind === 'accepted').length, 1);
    assert.equal(dispatchNotices.filter(n => n.kind === 'dropped_off').length, 1);
    await request(`/notifications/${acceptance.id}/read`, dispatch, 'PATCH');
    assert.ok(!(await request('/notifications', dispatch)).data.notifications.some(n => n.id === acceptance.id));

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
    // A driver must finish the active outbound leg, and collect payment on OW/return completion.
    const payable = { ...tripInput, driver: 'Test Driver', patientFirstName: 'Test', patientLastName: 'Patient',
      patientPays: 'Yes', payerType: 'Patient', patientAmount: 50, paymentCollected: false, payStatus: 'Pending' };
    const workflowPair = ['A','B'].map(leg => ({ ...payable, id: `workflow-${leg}`, group:'RT-workflow', leg }));
    await request('/trips', dispatch, 'POST', { trips: workflowPair });
    await request('/trips', dispatch, 'POST', { trips: [{ ...payable, id:'workflow-ow', group:'OW-workflow', leg:'A' }] });
    assert.equal((await request('/trips/workflow-A', first, 'PATCH', { action:'advance' })).status, 200);
    assert.equal((await request('/trips/workflow-ow', first, 'PATCH', { action:'advance' })).status, 409);
    for (let step = 0; step < 3; step++) await request('/trips/workflow-A', first, 'PATCH', { action:'advance' });
    assert.equal((await request('/trips/workflow-ow', first, 'PATCH', { action:'advance' })).status, 409); // Arrival is not drop-off.
    assert.equal((await request('/trips/workflow-A', first, 'PATCH', { action:'advance' })).status, 200); // Outbound can finish before R/T payment.
    assert.equal((await request('/trips/workflow-ow', first, 'PATCH', { action:'advance' })).status, 200);
    for (let step = 0; step < 3; step++) await request('/trips/workflow-ow', first, 'PATCH', { action:'advance' });
    assert.equal((await request('/trips/workflow-ow', first, 'PATCH', { action:'advance' })).status, 409);
    assert.equal((await request('/trips/workflow-ow', dispatch, 'PATCH', { action:'advance' })).status, 409);
    assert.equal((await request('/trips/workflow-ow', first, 'PATCH', { action:'collectPayment', paymentMethod:'Cash' })).status, 200);
    assert.equal((await request('/trips/workflow-ow', first, 'PATCH', { action:'advance' })).status, 200);
    await request('/trips/workflow-B', dispatch, 'PATCH', { action:'releaseReturn' });
    for (let step = 0; step < 4; step++) assert.equal((await request('/trips/workflow-B', first, 'PATCH', { action:'advance' })).status, 200);
    assert.equal((await request('/trips/workflow-B', first, 'PATCH', { action:'advance' })).status, 409);
    assert.equal((await request('/trips/workflow-B', first, 'PATCH', { action:'collectPayment', paymentMethod:'Credit Card' })).status, 200);
    for (const leg of ['workflow-A', 'workflow-B']) assert.equal((await request('/trips/' + leg, dispatch, 'PATCH', {action:'collectPayment', paymentMethod:'Cash'})).status, 409);
    assert.equal((await request('/trips/workflow-B', first, 'PATCH', { action:'advance' })).status, 200);
    await query("UPDATE driver_locations SET recorded_at=NOW() - INTERVAL '2 minutes'");
    assert.equal((await request('/driver-locations', dispatch)).data.locations[0].current, false);
    assert.equal((await request('/trips/pending-A', first, 'PATCH', { action: 'advance' })).status, 409);
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
