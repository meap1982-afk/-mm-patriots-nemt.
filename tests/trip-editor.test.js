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
  let confirmDelete = false, failCreate = false;
  const context = vm.createContext({
    document: { getElementById: id => fields.get(id), addEventListener() {} },
    localStorage: { getItem: () => 'null' }, window: {}, console,
    Option: function(text, value) { this.text = text; this.value = value; },
    confirm: () => confirmDelete, alert: value => alerts.push(value),
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (failCreate && options.method === "POST") throw new Error("Save unavailable");
      return { ok: true, status: 200, json: async () => url.endsWith('/config') ? { drivers: ['Test Driver'] } : { trips: [] } };
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("session = {role: 'dispatch'}; updateTripFormVisibility()", context);
  assert.equal(fields.get('tripForm').hidden, true);
  vm.runInContext('openCreateTrip(); render()', context);
  assert.equal(fields.get('tripForm').hidden, false);
  fields.get('patientFirstName').value = 'Unsaved draft';
  vm.runInContext('closeTripForm(); render()', context);
  assert.equal(fields.get('tripForm').hidden, true);
  assert.equal(fields.get('patientFirstName').value, 'Unsaved draft');
  const original = { id: 'return-b', tripDate: '2026-09-28', group: 'RT-test', leg: 'B', returnPending: true, status: 0,
    patientFirstName: 'Test', patientLastName: 'Patient', patient: 'Test Patient', phone: '5555550100',
    driver: 'Test Driver', type: 'Bariatric Wheelchair', payerType: 'Other', patientPays: 'Yes', payerFirstName: 'Pay', payerLastName: 'Person', payerRelationship: 'Friend', payerPhone: '+1 (555) 555-0123', timeType: 'Will Call',
    pickup: { type: 'Hospital', address: '123 Hospital Road, Town, VA 20164', room: '4' },
    dropoff: { type: 'Home', address: '456 Home Road, Town, VA 20164' }, dispatchNotes: 'Private before', notes: 'Before' };
  vm.runInContext(`session = {role: 'dispatch', token: 'test'}; tripFolder = 'pending'; trips = [${JSON.stringify(original)}]; editTrip('return-b')`, context);
  assert.equal(fields.get('tripFormTitle').textContent, 'Edit Return');
  assert.equal(fields.get('tripForm').hidden, false);
  vm.runInContext('render()', context);
  assert.equal(fields.get('tripForm').hidden, false);
  assert.equal(fields.get('aPickEditAddress').value, original.pickup.address);
  assert.equal(fields.get('aPickEditRoom').value, '4');
  assert.equal(fields.get('tripType').value, 'Bariatric Wheelchair');
  assert.equal(fields.get('isRT').disabled, true);
  assert.equal(fields.get('isRT').value, 'yes');
  assert.equal(fields.get('returnFields').classList.contains('hidden'), true);
  assert.equal(fields.get('payerPhone').value, original.payerPhone);
  fields.get('payerPhone').value = '+1 (555) 555-0456';
  assert.equal(fields.get('aDate').value, '2026-09-28');
  fields.get('aDate').value = '2026-09-29';
  fields.get('notes').value = 'Changed return';
  assert.equal(fields.get('dispatchNotes').value, 'Private before');
  fields.get('dispatchNotes').value = 'Private after';
  await vm.runInContext('createTrip()', context);
  const edit = calls.find(c => c.method === 'PATCH');
  assert.equal(edit.url, '/api/trips/return-b');
  assert.equal(JSON.parse(edit.body).action, 'edit');
  assert.equal(JSON.parse(edit.body).trip.notes, 'Changed return');
  assert.equal(JSON.parse(edit.body).trip.dispatchNotes, 'Private after');
  assert.equal(JSON.parse(edit.body).trip.tripDate, '2026-09-29');
  assert.equal(JSON.parse(edit.body).trip.payerPhone, '+1 (555) 555-0456');
  assert.equal(JSON.parse(edit.body).trip.pickup.address, original.pickup.address);
  assert.equal(JSON.parse(edit.body).trip.time, '');
  assert.ok(!calls.some(c => c.method === 'POST'));
  assert.equal(fields.get('patientFirstName').value, 'Unsaved draft');
  assert.equal(fields.get('tripFormTitle').textContent, 'Create Trip');
  assert.equal(fields.get('tripForm').hidden, true);
  assert.equal(fields.get('isRT').disabled, false);
  vm.runInContext(`trips = [${JSON.stringify(original)}]`, context);
  await vm.runInContext("deleteTrip('return-b')", context);
  assert.ok(!calls.some(c => c.method === 'DELETE'));
  confirmDelete = true;
  await vm.runInContext("deleteTrip('return-b')", context);
  assert.equal(calls.find(c => c.method === 'DELETE').url, '/api/trips/return-b');
  assert.equal(alerts.length, 1);
  vm.runInContext('openCreateTrip()', context);
  const values = {patientFirstName:'New', patientLastName:'Patient', phone:'5555550100',
    isRT:'yes', aDriver:'Test Driver', bDriver:'Test Driver', helperDriver:'Test Driver',
    payerType:'NoPay', aDate:'2026-09-28', bDate:'2026-09-28', aTimeType:'Will Call', bTimeType:'Will Call'};
  for (const prefix of ['aPick','aDrop']) Object.assign(values, {
    [prefix+'Number']:'123', [prefix+'Street']:'Example Road', [prefix+'City']:'Town',
    [prefix+'State']:'VA', [prefix+'Zip']:'20164', [prefix+'Room']:'4'
  });
  for (const [id,value] of Object.entries(values)) fields.get(id).value=value;
  failCreate = true;
  await vm.runInContext('createTrip()', context);
  assert.equal(fields.get('patientFirstName').value, 'New');
  assert.equal(fields.get('aDriver').value, 'Test Driver');
  assert.equal(fields.get('bDriver').value, 'Test Driver');
  failCreate = false;
  await vm.runInContext('createTrip()', context);
  const saved = JSON.parse(calls.filter(c => c.method === 'POST').at(-1).body).trips;
  assert.equal(saved.length, 2);
  assert.ok(saved.every(t => t.driver === 'Test Driver' && t.patient === 'New Patient'));
  vm.runInContext('openCreateTrip()', context);
  for (const id of ['patientFirstName','patientLastName','phone','payerPhone','aPickNumber','aDropNumber','notes','dispatchNotes'])
    assert.equal(fields.get(id).value, '', id);
  for (const id of ['aDriver','bDriver','helperDriver']) assert.equal(fields.get(id).value, 'Unassigned', id);

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


test('destination address, type, room and map are hidden until arrival at pickup', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, localStorage: { getItem: () => 'null' }, window: {}, console });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'), 'utf8').split('for (const leg of ["a", "b"])')[0], context);
  vm.runInContext(`trip = {id:'hidden', pickup:{address:'Pickup Road'}, dropoff:{address:'Secret Destination',type:'Secret Facility',room:'Secret Room'}}`, context);
  for (const status of [0,1]) {
    const card = vm.runInContext(`tripCard({...trip,status:${status}}, "driver")`, context);
    assert.match(card, /Destination hidden/);
    assert.doesNotMatch(card, /Secret|Secret%20/);
    assert.match(card, /Pickup Road/);
  }
  for (const status of [2,3,4,5]) {
    assert.match(vm.runInContext(`tripCard({...trip,status:${status}}, "driver")`, context), /Secret Destination/);
  }
  assert.match(vm.runInContext('tripCard({...trip,status:0}, "dispatch")', context), /Secret Destination/);
});


test('driver buttons explain drop-off and payment blocks without blocking collection', () => {
  const context = vm.createContext({ document:{addEventListener(){}}, localStorage:{getItem:()=> 'null'}, window:{},console });
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
  vm.runInContext(`locationOnline=true; trips=[{id:'active',group:'RT-first',leg:'A',status:4,driver:'Test'}, {id:'next',status:0,driver:'Test'}]`,context);
  const waiting=vm.runInContext('tripCard(trips[1],"driver")',context);
  assert.match(waiting, /onclick="advance\('next'\)" disabled/);
  assert.match(waiting, /complete the current trip/);
  vm.runInContext('trips[0].status=5',context);
  assert.doesNotMatch(vm.runInContext('tripCard(trips[1],"driver")',context), /onclick="advance\('next'\)" disabled/);
  vm.runInContext(`due={id:'due',group:'OW-one',leg:'A',status:4,patientPays:'Yes',patientAmount:50,paymentCollected:false}`,context);
  const unpaid=vm.runInContext('tripCard(due,"driver")',context);
  assert.match(unpaid,/onclick="advance\('due'\)" disabled/);
  assert.doesNotMatch(unpaid,/onclick="collectPayment\('due'\)" disabled/);
  assert.equal(vm.runInContext('tripAdvanceBlock({...due,paymentCollected:true})',context),'');
  assert.equal(vm.runInContext('tripAdvanceBlock({...due,group:"RT-pair",leg:"A"})',context),'');
  assert.notEqual(vm.runInContext('tripAdvanceBlock({...due,group:"RT-pair",leg:"B"})',context),'');
  assert.equal(vm.runInContext('tripAdvanceBlock({...due,patientPays:"No"})',context),'');
});


test('trip schedules sort by service date and time with will-call and undated trips last', () => {
  const elements = new Map();
  const context = vm.createContext({document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{});return elements.get(id);}}, localStorage:{getItem:()=> 'null'},window:{},console});
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
  vm.runInContext(`trips=[
    {id:'undated',patient:'Undated',status:0},
    {id:'tomorrow',patient:'Tomorrow',tripDate:'2026-10-02',time:'08:00',status:0},
    {id:'call',patient:'CallLater',tripDate:'2026-10-01',timeType:'Will Call',status:0},
    {id:'late',patient:'Afternoon',tripDate:'2026-10-01',time:'15:00',status:0},
    {id:'early',patient:'Morning',tripDate:'2026-10-01',time:'08:00',status:0}];todayTripDate=()=> '2026-09-26';tripFolder='upcoming';render()`,context);
  for (const id of ['dispatchTrips','driverTrips']) {
    const html=elements.get(id).innerHTML;
    const positions=['Morning','Afternoon','CallLater','Tomorrow'].map(name=>html.indexOf(name));
    assert.deepEqual(positions,[...positions].sort((a,b)=>a-b));
    assert.match(html,/Thu, Oct 1, 2026/);
    assert.doesNotMatch(html,/Undated/);
  }
  assert.equal(vm.runInContext('validTripDate("2028-02-29")',context),true);
  assert.equal(vm.runInContext('validTripDate("2026-02-29")',context),false);
});


test('private Dispatch notes are escaped and never rendered in driver cards',()=>{
  const context=vm.createContext({document:{addEventListener(){}},localStorage:{getItem:()=> 'null'},window:{},console});
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
  vm.runInContext(`trip={id:'private',dispatchNotes:'Secret <script>alert(1)</script>',status:2}`,context);
  assert.match(vm.runInContext('tripCard(trip,"dispatch")',context),/Secret &lt;script&gt;/);
  assert.doesNotMatch(vm.runInContext('tripCard(trip,"driver")',context),/Secret|Dispatch Notes/);
});
