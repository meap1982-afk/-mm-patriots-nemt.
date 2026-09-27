'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('Today is default, old trips remain accessible, pending returns follow dates, and midnight moves folders',()=>{
  const elements=new Map();
  const context=vm.createContext({document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{});return elements.get(id);}},localStorage:{getItem:()=> 'null'},window:{},console});
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
  vm.runInContext(`todayTripDate=()=> '2026-09-26'; trips=[
    {id:'today',patient:'TodayPatient',tripDate:'2026-09-26',time:'09:00',status:0,driver:'Test'},
    {id:'future',patient:'FuturePatient',tripDate:'2026-09-27',time:'09:00',status:0},
    {id:'past',patient:'PastPatient',tripDate:'2026-09-25',time:'09:00',status:4,driver:'Test'},
    {id:'pending',patient:'OldReturn',tripDate:'2026-09-25',leg:'B',group:'RT-old',returnPending:true,status:0},
    {id:'unknown',patient:'UnknownDate',status:0}];render()`,context);
  assert.equal(vm.runInContext('tripFolder',context),'today');
  for(const id of ['dispatchTrips','driverTrips']){
    assert.match(elements.get(id).innerHTML,/TodayPatient/);
    assert.doesNotMatch(elements.get(id).innerHTML,/PastPatient|FuturePatient|UnknownDate|OldReturn/);
  }
  assert.equal(elements.get('kTotal').textContent,1);
  assert.match(elements.get('olderActiveTrips').innerHTML,/1 unfinished/);
  assert.match(vm.runInContext('tripAdvanceBlock(trips[0])',context),/complete the current trip/);
  vm.runInContext('selectTripFolder("past")',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/PastPatient/);
  assert.match(elements.get('pendingReturnTrips').innerHTML,/OldReturn/);
  assert.equal(elements.get('kPendingReturns').textContent,1);
  vm.runInContext('selectTripFolder("upcoming")',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/FuturePatient/);
  vm.runInContext('selectTripFolder("undated")',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/UnknownDate/);
  assert.equal(vm.runInContext('trips.length',context),5);
  vm.runInContext('todayTripDate=()=> "2026-09-27"; selectTripFolder("today")',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/FuturePatient/);
  assert.doesNotMatch(elements.get('dispatchTrips').innerHTML,/TodayPatient/);
  vm.runInContext('selectTripFolder("past")',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/TodayPatient/);
});


test('driver sees current and upcoming only, cannot select history, and completion removes card',()=>{
  const elements=new Map();
  const context=vm.createContext({document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{});return elements.get(id);}},localStorage:{getItem:()=> 'null'},window:{},console});
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
  vm.runInContext(`session={role:'driver',driver:'Test'};trips=[
    {id:'oldactive',patient:'CurrentPatient',tripDate:'2026-09-20',status:4},
    {id:'next',patient:'NextPatient',tripDate:'2026-10-01',status:0},
    {id:'done',patient:'CompletedPatient',tripDate:'2026-09-26',status:5},
    {id:'cancelled',patient:'CancelledPatient',status:0,cancelled:true},
    {id:'held',patient:'HeldReturn',status:0,leg:'B',group:'RT-held',returnPending:true}];render()`,context);
  assert.match(elements.get('driverTrips').innerHTML,/CurrentPatient/);
  assert.match(elements.get('driverTrips').innerHTML,/NextPatient/);
  assert.doesNotMatch(elements.get('driverTrips').innerHTML,/CompletedPatient|CancelledPatient|HeldReturn/);
  assert.doesNotMatch(elements.get('tripFolderNav').innerHTML,/Past Trips|Date Not Set|selectTripFolder/);
  vm.runInContext('selectTripFolder("past")',context);
  assert.equal(vm.runInContext('tripFolder',context),'today');
  vm.runInContext('trips[0].status=5;render()',context);
  assert.doesNotMatch(elements.get('driverTrips').innerHTML,/CurrentPatient/);
  vm.runInContext('session={role:"dispatch"};todayTripDate=()=>"2026-09-26";render()',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/CompletedPatient/);
});


test('Pending collects returns across all dates and removes released or cancelled returns',()=>{
  const elements=new Map();
  const context=vm.createContext({document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{});return elements.get(id);}},localStorage:{getItem:()=> 'null'},window:{},console});
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
  vm.runInContext(`session={role:'dispatch'};todayTripDate=()=> '2026-09-26';drivers=['Test'];
    trips=['2026-09-25','2026-09-26','2026-09-27',''].map((tripDate,i)=>({id:'return'+i,patient:'ReturnPatient'+i,tripDate,leg:'B',group:'RT-'+i,returnPending:true,status:0,driver:'Test'}));
    trips.push({id:'pickup',patient:'PickupPatient',tripDate:'2026-09-26',leg:'A',group:'RT-1',status:0});render()`,context);
  assert.match(elements.get('tripFolderNav').innerHTML,/Pending \(4\)/);
  vm.runInContext('selectTripFolder("pending")',context);
  for(let i=0;i<4;i++)assert.match(elements.get('pendingReturnTrips').innerHTML,new RegExp('ReturnPatient'+i));
  assert.doesNotMatch(elements.get('pendingReturnTrips').innerHTML,/PickupPatient/);
  assert.equal(elements.get('dispatchTrips').hidden,true);
  assert.equal(elements.get('tripForm').hidden,true);
  assert.equal(elements.get('kPendingReturns').textContent,4);
  vm.runInContext('trips[0].returnPending=false;trips[1].cancelled=true;render()',context);
  assert.match(elements.get('tripFolderNav').innerHTML,/Pending \(2\)/);
  assert.doesNotMatch(elements.get('pendingReturnTrips').innerHTML,/ReturnPatient0|ReturnPatient1/);
  vm.runInContext('selectTripFolder("past")',context);
  assert.match(elements.get('dispatchTrips').innerHTML,/ReturnPatient0/);
  assert.equal(elements.get('dispatchTrips').hidden,false);
  assert.equal(elements.get('tripForm').hidden,true);
  vm.runInContext('session={role:"driver"};selectTripFolder("pending")',context);
  assert.equal(vm.runInContext('tripFolder',context),'past');
});
