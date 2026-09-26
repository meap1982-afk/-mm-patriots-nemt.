'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Dispatch edits only the selected return, cancels to the original form, and confirms deletion', async () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const fields = new Map(), calls = [], alerts = [];
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const [tag, type, id] = match;
    const classes = new Set((tag.match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
    const options = type === 'select' ? [...html.slice(match.index + tag.length).split('</select>')[0].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(o => ({ value: o[1].match(/value="([^"]*)"/)?.[1] ?? o[2], selected: o[1].includes('selected') })) : [];
    fields.set(id, { id, tagName: type.toUpperCase(), options, disabled: false,
      value: options.find(o => o.selected)?.value ?? options[0]?.value ?? tag.match(/value="([^"]*)"/)?.[1] ?? '',
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
      add(option) { options.push(option); }, addEventListener() {}, scrollIntoView() {}, focus() {}
    });
  }
  fields.get('tripForm').querySelectorAll = () => [...fields.values()].filter(f => ['INPUT', 'SELECT', 'TEXTAREA'].includes(f.tagName) && !['accessCode', 'loginDriver'].includes(f.id));
  let confirmDelete = false;
  const context = vm.createContext({
    document: { getElementById: id => fields.get(id), addEventListener() {} },
    localStorage: { getItem: () => 'null' }, window: {}, console,
    Option: function(text, value) { this.text = text; this.value = value; },
    confirm: () => confirmDelete, alert: value => alerts.push(value),
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      return { ok: true, status: 200, json: async () => url.endsWith('/config') ? { drivers: ['Test Driver'] } : { trips: [] } };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  fields.get('patientFirstName').value = 'Unsaved draft';
  const original = { id: 'return-b', group: 'RT-test', leg: 'B', returnPending: true, status: 0,
    patientFirstName: 'Test', patientLastName: 'Patient', patient: 'Test Patient', phone: '5555550100',
    driver: 'Test Driver', type: 'Bariatric Wheelchair', payerType: 'Other', patientPays: 'Yes', payerFirstName: 'Pay', payerLastName: 'Person', payerRelationship: 'Friend', payerPhone: '+1 (555) 555-0123', timeType: 'Will Call',
    pickup: { type: 'Hospital', address: '123 Hospital Road, Town, VA 20164', room: '4' },
    dropoff: { type: 'Home', address: '456 Home Road, Town, VA 20164' }, notes: 'Before' };
  vm.runInContext(`session = {role: 'dispatch', token: 'test'}; trips = [${JSON.stringify(original)}]; editTrip('return-b')`, context);
  assert.equal(fields.get('tripFormTitle').textContent, 'Edit Return');
  assert.equal(fields.get('aPickEditAddress').value, original.pickup.address);
  assert.equal(fields.get('aPickEditRoom').value, '4');
  assert.equal(fields.get('tripType').value, 'Bariatric Wheelchair');
  assert.equal(fields.get('isRT').disabled, true);
  assert.equal(fields.get('isRT').value, 'yes');
  assert.equal(fields.get('returnFields').classList.contains('hidden'), true);
  assert.equal(fields.get('payerPhone').value, original.payerPhone);
  fields.get('payerPhone').value = '+1 (555) 555-0456';
  fields.get('notes').value = 'Changed return';
  await vm.runInContext('createTrip()', context);
  const edit = calls.find(c => c.method === 'PATCH');
  assert.equal(edit.url, '/api/trips/return-b');
  assert.equal(JSON.parse(edit.body).action, 'edit');
  assert.equal(JSON.parse(edit.body).trip.notes, 'Changed return');
  assert.equal(JSON.parse(edit.body).trip.payerPhone, '+1 (555) 555-0456');
  assert.equal(JSON.parse(edit.body).trip.pickup.address, original.pickup.address);
  assert.equal(JSON.parse(edit.body).trip.time, '');
  assert.ok(!calls.some(c => c.method === 'POST'));
  assert.equal(fields.get('patientFirstName').value, 'Unsaved draft');
  assert.equal(fields.get('tripFormTitle').textContent, 'Create Trip');
  assert.equal(fields.get('isRT').disabled, false);
  vm.runInContext(`trips = [${JSON.stringify(original)}]`, context);
  await vm.runInContext("deleteTrip('return-b')", context);
  assert.ok(!calls.some(c => c.method === 'DELETE'));
  confirmDelete = true;
  await vm.runInContext("deleteTrip('return-b')", context);
  assert.equal(calls.find(c => c.method === 'DELETE').url, '/api/trips/return-b');
  assert.equal(alerts.length, 1);
});

 test('driver can see and dial the payer separately from the patient', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, localStorage: { getItem: () => 'null' }, window: {}, console });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8').split('for (const leg of ["a", "b"])')[0], context);
  vm.runInContext(`trip = {id: 'call', patient: 'Patient', phone: '5555550100', patientPays: 'Yes', payerType: 'Other', payerFirstName: 'Other', payerLastName: 'Person', payerPhone: '+1 (555) 555-0456'};`, context);
  const card = vm.runInContext('tripCard(trip, "driver")', context);
  assert.match(card, /Payer Phone: <b>\+1 \(555\) 555-0456/);
  assert.match(card, /href="tel:\+15555550456"[^>]*>📞 CALL PAYER/);
  assert.match(card, /href="tel:5555550100"[^>]*>📞 CALL PATIENT/);
  assert.doesNotMatch(vm.runInContext('tripCard({...trip, payerPhone: ""}, "driver")', context), /CALL PAYER/);
  assert.doesNotMatch(vm.runInContext('tripCard({...trip, patientPays: "No", payerType: "NoPay"}, "driver")', context), /CALL PAYER/);
});
