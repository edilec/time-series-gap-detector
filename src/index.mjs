export const TOOL_ID='time-series-gap-detector';
export const LIMITS=Object.freeze({policyBytes:65536,recordsBytes:1048576,devices:100,records:10000,slots:10000,depth:16,milliseconds:5000});
export const RULES=Object.freeze({'policy-invalid':'warning','records-invalid':'warning','records-incomplete':'warning','device-unknown':'warning','pending-gap':'warning','limit-exceeded':'warning','input-unreadable':'warning','permanent-gap':'error','duplicate-record':'error','out-of-order':'error','off-cadence':'error','late-record':'error'});
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const only=(x,keys)=>Object.keys(x).every(k=>keys.includes(k));
const slug=x=>typeof x==='string'&&x.trim().length>0&&x.length<=256&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u.test(x);
const instant=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,19)===x.slice(0,19);
const cmp=(a,b)=>a<b?-1:a>b?1:0;
function timezone(x){if(typeof x!=='string'||x.length>100)return false;try{new Intl.DateTimeFormat('en-US',{timeZone:x});return true;}catch{return false;}}
function depth(x){const stack=[[x,0,new Set()]];while(stack.length){const[v,n,a]=stack.pop();if(n>LIMITS.depth)return n;if(v&&typeof v==='object'){if(a.has(v))return LIMITS.depth+1;const next=new Set(a);next.add(v);for(const c of Object.values(v))stack.push([c,n+1,next]);}}return 0;}
export function validPolicy(p){
  if(!obj(p)||!only(p,['schemaVersion','asOf','devices'])||p.schemaVersion!=='1'||!instant(p.asOf)||!Array.isArray(p.devices)||!p.devices.length)return false;
  return p.devices.every(d=>obj(d)&&only(d,['id','timeZone','cadenceMinutes','lateGraceMinutes','windowStart','windowEnd'])&&slug(d.id)&&timezone(d.timeZone)&&Number.isSafeInteger(d.cadenceMinutes)&&d.cadenceMinutes>=1&&d.cadenceMinutes<=1440&&Number.isSafeInteger(d.lateGraceMinutes)&&d.lateGraceMinutes>=0&&d.lateGraceMinutes<=1440&&instant(d.windowStart)&&instant(d.windowEnd)&&Date.parse(d.windowEnd)>=Date.parse(d.windowStart)&&(Date.parse(d.windowEnd)-Date.parse(d.windowStart))%(d.cadenceMinutes*60000)===0)&&new Set(p.devices.map(d=>d.id)).size===p.devices.length;
}
export function detectGaps(recordsDoc,policy,{now=Date.now,deadline=now()+LIMITS.milliseconds}={}){
  const findings=[];
  const add=(ruleId,file,pointer,message)=>{if(!Object.hasOwn(RULES,ruleId))throw new Error('Unknown rule');findings.push({ruleId,severity:RULES[ruleId],message,location:{file,pointer}});};
  const finish=(checked,expectedSlots)=>{findings.sort((a,b)=>cmp(a.location.file,b.location.file)||cmp(a.location.pointer,b.location.pointer)||cmp(a.ruleId,b.ruleId));return{schemaVersion:'1',tool:TOOL_ID,status:findings.some(f=>f.severity==='warning')?'incomplete':findings.length?'fail':checked||expectedSlots?'pass':'incomplete',summary:{checked,expectedSlots,errors:findings.filter(f=>f.severity==='error').length,warnings:findings.filter(f=>f.severity==='warning').length},findings};};
  if(!validPolicy(policy)){add('policy-invalid','@policy','','Cadence policy is invalid.');return finish(0,0);}
  if(policy.devices.length>LIMITS.devices){add('limit-exceeded','@policy','/devices','Device policy count exceeds limit.');return finish(0,0);}
  let slots=0;for(const d of policy.devices){slots+=(Date.parse(d.windowEnd)-Date.parse(d.windowStart))/(d.cadenceMinutes*60000)+1;if(slots>LIMITS.slots){add('limit-exceeded','@policy','/devices','Expected slot count exceeds limit.');return finish(0,0);}}
  if(depth(recordsDoc)>LIMITS.depth){add('limit-exceeded','@records','','Record export JSON depth limit exceeded.');return finish(0,slots);}
  if(!obj(recordsDoc)||!only(recordsDoc,['schemaVersion','complete','records'])||recordsDoc.schemaVersion!=='1'||typeof recordsDoc.complete!=='boolean'||!Array.isArray(recordsDoc.records)){add('records-invalid','@records','','Record export shape is invalid.');return finish(0,slots);}
  if(recordsDoc.records.length>LIMITS.records){add('limit-exceeded','@records','/records','Telemetry record limit exceeded.');return finish(0,slots);}
  if(!recordsDoc.complete)add('records-incomplete','@records','/complete','Telemetry export declares partial coverage.');
  const byDevice=new Map(policy.devices.map(d=>[d.id,{policy:d,seen:new Set(),previous:null}])),asOf=Date.parse(policy.asOf);
  for(let i=0;i<recordsDoc.records.length;i++){
    if(now()>deadline){add('limit-exceeded','@records','','Evaluation deadline exceeded.');return finish(i,slots);}
    const r=recordsDoc.records[i],at=`/records/${i}`;
    if(!obj(r)||!only(r,['deviceId','observedAt','receivedAt'])||!slug(r.deviceId)||!instant(r.observedAt)||!instant(r.receivedAt)){add('records-invalid','@records',at,'Telemetry record identity or timestamps are invalid.');continue;}
    const series=byDevice.get(r.deviceId);
    if(!series){add('device-unknown','@records',at,'Telemetry device has no configured cadence.');continue;}
    const observed=Date.parse(r.observedAt),received=Date.parse(r.receivedAt),d=series.policy,start=Date.parse(d.windowStart),end=Date.parse(d.windowEnd),cadence=d.cadenceMinutes*60000,grace=d.lateGraceMinutes*60000;
    if(received<observed||received>asOf){add('records-invalid','@records',at,'Record receipt time is inconsistent with observation or declared as-of instant.');continue;}
    if(series.previous!==null&&observed<series.previous)add('out-of-order','@records',at,'Device records are not in observed-time order.');
    series.previous=observed;
    if(series.seen.has(observed))add('duplicate-record','@records',at,'Device interval has duplicate telemetry records.');
    else series.seen.add(observed);
    if(observed<start||observed>end){add('records-invalid','@records',at,'Record is outside declared device window.');continue;}
    if((observed-start)%cadence!==0){add('off-cadence','@records',at,'Record does not align with elapsed-time cadence.');continue;}
    if(received>observed+grace)add('late-record','@records',at,'Record arrived after declared grace interval.');
  }
  for(let i=0;i<policy.devices.length;i++){
    const d=policy.devices[i],series=byDevice.get(d.id),start=Date.parse(d.windowStart),end=Date.parse(d.windowEnd),cadence=d.cadenceMinutes*60000,grace=d.lateGraceMinutes*60000;
    for(let t=start,j=0;t<=end;t+=cadence,j++){
      if(now()>deadline){add('limit-exceeded','@policy','','Evaluation deadline exceeded.');return finish(recordsDoc.records.length,slots);}
      if(series.seen.has(t))continue;
      if(!recordsDoc.complete)continue;
      if(asOf<t+grace)add('pending-gap','@policy',`/devices/${i}`,`Expected slot ordinal ${j} is still within arrival grace.`);
      else add('permanent-gap','@policy',`/devices/${i}`,`Expected slot ordinal ${j} has no record after arrival grace.`);
    }
  }
  return finish(recordsDoc.records.length,slots);
}
