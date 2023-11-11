import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGaps, TOOL_ID, LIMITS, RULES } from '../src/index.mjs';
import { runCli } from '../src/cli.mjs';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const device={id:'synthetic-device',timeZone:'America/New_York',cadenceMinutes:60,lateGraceMinutes:30,windowStart:'2026-03-08T06:00:00Z',windowEnd:'2026-03-08T08:00:00Z'};
const policy={schemaVersion:'1',asOf:'2026-03-08T10:00:00Z',devices:[device]};
const mk=(observedAt,receivedAt=observedAt)=>({deviceId:device.id,observedAt,receivedAt});
const records={schemaVersion:'1',complete:true,records:[mk('2026-03-08T06:00:00Z'),mk('2026-03-08T07:00:00Z'),mk('2026-03-08T08:00:00Z')]};
const check=(r=records,p=policy)=>detectGaps(r,p);

test('DST spring-forward boundary has no phantom gap with elapsed cadence',()=>{
  const report=check();assert.equal(TOOL_ID,'time-series-gap-detector');assert.equal(report.status,'pass');assert.equal(report.summary.checked,3);
  assert.equal(JSON.stringify(report).includes('synthetic-device'),false);
});

test('delayed present record is distinct from a permanent missing interval',()=>{
  const late=check({...records,records:[records.records[0],mk('2026-03-08T07:00:00Z','2026-03-08T07:31:00Z'),records.records[2]]});
  assert.equal(late.status,'fail');assert.ok(late.findings.some(f=>f.ruleId==='late-record'));
  assert.equal(late.findings.some(f=>f.ruleId==='permanent-gap'),false);
  const gap=check({...records,records:[records.records[0],records.records[2]]});
  assert.equal(gap.status,'fail');assert.ok(gap.findings.some(f=>f.ruleId==='permanent-gap'));
  assert.equal(gap.findings.some(f=>f.ruleId==='late-record'),false);
});

test('duplicate, out-of-order and off-cadence records have separate findings',()=>{
  const duplicate=check({...records,records:[...records.records,mk('2026-03-08T08:00:00Z')]});
  assert.ok(duplicate.findings.some(f=>f.ruleId==='duplicate-record'));
  const reversed=check({...records,records:[records.records[1],records.records[0],records.records[2]]});
  assert.ok(reversed.findings.some(f=>f.ruleId==='out-of-order'));
  const off=check({...records,records:[...records.records,mk('2026-03-08T06:30:00Z')]});
  assert.ok(off.findings.some(f=>f.ruleId==='off-cadence'));
});

test('pending gap, incomplete export, and unknown device cannot become permanent pass',()=>{
  const pendingPolicy={...policy,asOf:'2026-03-08T07:10:00Z'};
  const partial={...records,records:[records.records[0],records.records[2]]};
  const pending=check(partial,pendingPolicy);assert.equal(pending.status,'incomplete');assert.ok(pending.findings.some(f=>f.ruleId==='pending-gap'));
  const incomplete=check({...partial,complete:false});assert.equal(incomplete.status,'incomplete');assert.equal(incomplete.findings.some(f=>f.ruleId==='permanent-gap'),false);
  const unknown=check({...records,records:[...records.records,{...records.records[0],deviceId:'unconfigured'}]});
  assert.equal(unknown.status,'incomplete');assert.ok(unknown.findings.some(f=>f.ruleId==='device-unknown'));
});

test('records/devices/slots/depth N/N+1 and injected deadline',()=>{
  const many=n=>({...records,records:Array.from({length:n},(_,i)=>mk('2026-03-08T06:00:00Z','2026-03-08T06:00:00Z'))});
  assert.equal(check(many(LIMITS.records)).findings.some(f=>f.ruleId==='limit-exceeded'),false);
  assert.ok(check(many(LIMITS.records+1)).findings.some(f=>f.ruleId==='limit-exceeded'));
  const manyDevices=n=>({...policy,devices:Array.from({length:n},(_,i)=>({...device,id:`device-${i}`}))});
  assert.equal(check({...records,records:[]},manyDevices(LIMITS.devices)).findings.some(f=>f.ruleId==='limit-exceeded'),false);
  assert.ok(check(records,manyDevices(LIMITS.devices+1)).findings.some(f=>f.ruleId==='limit-exceeded'));
  const slotPolicy=n=>({...policy,devices:[{...device,windowStart:'2026-01-01T00:00:00Z',windowEnd:new Date(Date.parse('2026-01-01T00:00:00Z')+(n-1)*60000).toISOString(),cadenceMinutes:1}]});
  assert.equal(check({...records,records:[]},slotPolicy(LIMITS.slots)).findings.some(f=>f.ruleId==='limit-exceeded'),false);
  assert.ok(check(records,slotPolicy(LIMITS.slots+1)).findings.some(f=>f.ruleId==='limit-exceeded'));
  const deep=n=>{const d=structuredClone(records);let x=d;for(let i=0;i<n;i++){x.extra={};x=x.extra;}return d;};
  assert.equal(check(deep(16)).findings.some(f=>f.ruleId==='limit-exceeded'),false);
  assert.ok(check(deep(17)).findings.some(f=>f.ruleId==='limit-exceeded'));
  assert.equal(detectGaps(records,policy,{now:()=>5000,deadline:5000}).status,'pass');
  assert.equal(detectGaps(records,policy,{now:()=>5001,deadline:5000}).status,'incomplete');
});

test('CLI confinement, escaped duplicate keys and byte N/N+1',()=>{
  const root=mkdtempSync(join(tmpdir(),'series-')),outside=mkdtempSync(join(tmpdir(),'series-out-'));
  const args=['--root',root,'--policy','policy.json','--records','records.json'];
  const capture=()=>{let stdout='';return{io:{stdout:{write:s=>{stdout+=s;}},stderr:{write(){}}},get stdout(){return stdout;}};};
  try{const base={'policy.json':JSON.stringify(policy),'records.json':JSON.stringify(records)};for(const [name,raw] of Object.entries(base))writeFileSync(join(root,name),raw);
    let o=capture();assert.equal(runCli(args,o.io),0);assert.equal(JSON.parse(o.stdout).status,'pass');
    writeFileSync(join(root,'records.json'),base['records.json'].replace('"complete":true','"compl\\u0065te":false,"complete":true'));
    o=capture();assert.equal(runCli(args,o.io),2);assert.equal(JSON.parse(o.stdout).status,'incomplete');
    writeFileSync(join(outside,'records.json'),base['records.json']);symlinkSync(join(outside,'records.json'),join(root,'linked.json'));
    o=capture();assert.equal(runCli(['--root',root,'--policy','policy.json','--records','linked.json'],o.io),2);assert.equal(o.stdout,'');
    o=capture();assert.equal(runCli(['--root',join(root,'policy.json'),'--policy','policy.json','--records','records.json'],o.io),2);assert.equal(o.stdout,'');
    for(const [file,limit] of [['policy.json',LIMITS.policyBytes],['records.json',LIMITS.recordsBytes]])for(const delta of [0,1]){for(const [name,raw] of Object.entries(base))writeFileSync(join(root,name),raw);const raw=base[file];writeFileSync(join(root,file),raw+' '.repeat(limit+delta-Buffer.byteLength(raw)));o=capture();runCli(args,o.io);if(file==='policy.json')assert.equal(o.stdout==='',delta===1);else assert.equal(JSON.parse(o.stdout).findings.some(f=>f.ruleId==='limit-exceeded'),delta===1);}
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('severity table is pinned',()=>{assert.deepEqual(RULES,{'policy-invalid':'warning','records-invalid':'warning','records-incomplete':'warning','device-unknown':'warning','pending-gap':'warning','limit-exceeded':'warning','input-unreadable':'warning','permanent-gap':'error','duplicate-record':'error','out-of-order':'error','off-cadence':'error','late-record':'error'});});
