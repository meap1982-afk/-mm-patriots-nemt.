'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('patient list sorts by time and name and requires both RT legs completed',()=>{
 const context=vm.createContext({document:{addEventListener(){}},localStorage:{getItem:()=> 'null'},window:{},console});
 vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8').split('for (const leg of ["a", "b"])')[0],context);
 vm.runInContext(`trips=[
 {id:'a',group:'RT-1',leg:'A',patient:'Zoe',tripDate:'2026-09-28',time:'09:00',status:5},
 {id:'b',group:'RT-1',leg:'B',patient:'Zoe',tripDate:'2026-09-28',time:'12:00',status:0},
 {id:'c',patient:'Amy',tripDate:'2026-09-28',time:'09:00',status:5},
 {id:'d',patient:'Early',tripDate:'2026-09-28',time:'08:00',status:0}];`,context);
 let html=vm.runInContext('patientListRows(trips)',context);
 assert.ok(html.indexOf('Early')<html.indexOf('Amy'));
 assert.ok(html.indexOf('Amy')<html.indexOf('Zoe'));
 assert.equal((html.match(/Zoe/g)||[]).length,1);
 assert.match(html,/R\/T · Pending \/ incomplete/);
 assert.equal((html.match(/patient-dot complete/g)||[]).length,1);
 vm.runInContext('trips[1].status=5',context);
 html=vm.runInContext('patientListRows(trips)',context);
 assert.match(html,/R\/T · Completed/);
 assert.equal((html.match(/patient-dot complete/g)||[]).length,2);
 vm.runInContext('trips[1].cancelled=true',context);
 assert.match(vm.runInContext('patientListRows(trips)',context),/Cancelled \/ review trip/);
});
