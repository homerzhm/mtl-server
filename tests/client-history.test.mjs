import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const service = 'http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant';
const staff = {sub:'client-history-staff',staff:true,firebase:{sign_in_provider:'google.com'}};
const admin = {...staff,admin:true};
const uuid = () => randomUUID().replaceAll('-','');
function token(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg:'none',typ:'JWT'})}.${encode({aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})}.`;
}
async function call(operationName,variables={},claims=staff) {
  const headers={'Content-Type':'application/json'};
  if(claims) headers['x-firebase-auth-token']=token(claims);
  const kind=/^(List|Get)/.test(operationName)?'Query':'Mutation';
  const response=await fetch(`${service}/connectors/staff-admin:execute${kind}`,{method:'POST',headers,body:JSON.stringify({operationName,variables})});
  const body=await response.json();
  return {ok:response.ok&&!body.errors?.length,body};
}
async function ok(name,vars,claims=staff) {
  const result=await call(name,vars,claims);
  assert.equal(result.ok,true,`${name}: ${JSON.stringify(result.body)}`);
  return result.body.data;
}
async function client(phoneNumber=null) {
  const id=uuid();
  // Unique test number, deliberately international.
  phoneNumber??='+63'+String(BigInt('0x'+id.slice(0,9))).padStart(11,'0');
  await ok('CreateClient',{id,phoneNumber});
  return {id,phoneNumber};
}
async function product() {
  const id=uuid();
  await ok('CreateProduct',{id,name:'History test',priceCents:2000,isActive:true,capacityGroupId:null},admin);
  return id;
}
async function order(productId,extra={}) {
  const id=uuid();
  await ok('CreateOrder',{id,itemId:uuid(),productId,quantity:1,...extra});
  return id;
}
async function summary(id) { return (await ok('GetClientSummary',{id})).clientDirectoryEntries[0]; }

test('summary counts cancellations and sums receipts/refunds independently; history follows ID',async()=>{
  const c=await client(); const p=await product();
  const a=await order(p,{clientId:c.id,scheduledFor:'2030-01-01T00:00:00Z'});
  const b=await order(p,{clientId:c.id});
  const unlinked=await order(p,{contactPhoneNumber:c.phoneNumber});
  const paymentId=uuid();
  await ok('RecordCashPayment',{id:a,expectedRevision:0,paymentId,amountCents:1000});
  await ok('RecordCashPayment',{id:a,expectedRevision:1,paymentId:uuid(),amountCents:500});
  await ok('RefundCashPayment',{id:a,expectedRevision:2,paymentId,refundId:uuid(),amountCents:100},admin);
  await ok('RefundCashPayment',{id:a,expectedRevision:3,paymentId,refundId:uuid(),amountCents:200},admin);
  await ok('CancelOrder',{id:a,expectedRevision:4,cancellationTotalCents:1200});
  await ok('UpdateClient',{id:c.id,phoneNumber:'+442079460123',expectedRevision:0});
  const s=await summary(c.id);
  assert.equal(Number(s.orderCount),2);
  assert.equal(Number(s.netPaidCents),1200);
  const history=(await ok('ListClientHistory',{id:c.id})).orders;
  assert.deepEqual(history.map(o=>o.id),[b,a]);
  assert.ok(!history.some(o=>o.id===unlinked));
  assert.equal(Date.parse(s.lastOrderDate),Date.parse(history[0].createdAt));
  assert.equal(history[1].status,'CANCELLED');
  assert.equal(history[1].cancellationTotalCents,1200);
  assert.equal(history[0].finalTotalCents,null);
  await ok('CancelOrder',{id:b,expectedRevision:0,cancellationTotalCents:0});
  assert.equal((await summary(c.id)).lastOrderDate,null);
});

test('zero-order summary exists and missing client has no summary',async()=>{
  const c=await client();const s=await summary(c.id);
  assert.equal(Number(s.orderCount),0);assert.equal(Number(s.netPaidCents),0);assert.equal(s.lastOrderDate,null);
  assert.deepEqual((await ok('ListClientHistory',{id:c.id})).orders,[]);
  assert.deepEqual((await ok('GetClientSummary',{id:uuid()})).clientDirectoryEntries,[]);
});

test('new reads require Google staff/admin claims',async()=>{
  const c=await client();
  const operations=[['ListClientDirectory',{}],['GetClientSummary',{id:c.id}],['ListClientHistory',{id:c.id}]];
  for(const claims of [staff,{sub:'admin',admin:true,firebase:{sign_in_provider:'google.com'}}]) {
    for(const [name,vars] of operations) await ok(name,vars,claims);
  }
  for(const claims of [null,{sub:'customer',firebase:{sign_in_provider:'google.com'}},{...staff,staff:'true'},{...staff,firebase:{sign_in_provider:'password'}}]) {
    for(const [name,vars] of operations) assert.equal((await call(name,vars,claims)).ok,false,name);
  }
});

test('history pages beyond 100 in creation date and UUID order',async()=>{
  const c=await client();const p=await product();const ids=[];
  for(let i=0;i<105;i++) ids.push(await order(p,{clientId:c.id}));
  const history=[];
  for(let offset=0;;offset+=100) {
    const page=(await ok('ListClientHistory',{id:c.id,offset})).orders;
    assert.ok(page.length<=100);
    history.push(...page);if(page.length<100) break;
  }
  assert.equal(history.length,105);assert.equal(new Set(history.map(o=>o.id)).size,105);
  assert.deepEqual(new Set(history.map(o=>o.id)),new Set(ids));
  assert.deepEqual(history,[...history].sort((a,b)=>
    Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.id.localeCompare(a.id)));
  assert.equal(Number((await summary(c.id)).orderCount),105);
});

test('directory pages beyond 100 clients without duplicates or missing contacts',async()=>{
  // Isolate the pages from concurrent client inserts in other test files.
  const phoneNumber='+63'+String(BigInt('0x'+uuid().slice(0,8))).padStart(10,'0');
  const fixtures=[];
  for(let i=0;i<105;i++) fixtures.push(await client(phoneNumber+String(i).padStart(3,'0')));
  const clients=[];
  for(let offset=0;;offset+=100) {
    const page=(await ok('ListClientDirectory',{phoneNumber,offset})).clientDirectoryEntries;
    assert.ok(page.length<=100);
    clients.push(...page);if(page.length<100) break;
  }
  assert.equal(clients.length,105);
  const ids=clients.map(row=>row.id);
  assert.equal(new Set(ids).size,clients.length);
  assert.deepEqual(ids,[...ids].sort());
  assert.ok(fixtures.every(c=>ids.includes(c.id)));
  const c=fixtures[0];
  const matching=(await ok('ListClientDirectory',{phoneNumber:c.phoneNumber.slice(3)})).clientDirectoryEntries;
  assert.ok(matching.some(row=>row.id===c.id));
  assert.ok(matching.every(row=>row.phoneNumber.includes(c.phoneNumber.slice(3))));
  assert.deepEqual((await ok('ListClientDirectory',{phoneNumber:'999999999999999'})).clientDirectoryEntries,[]);
  for(const phoneNumber of ['%', '_', '416-555', '416 555', 'abc']) {
    assert.equal((await call('ListClientDirectory',{phoneNumber})).ok,false,phoneNumber);
  }
});

test('summary excludes voided payments and refunds',async()=>{
  const c=await client();const p=await product();
  const id=await order(p,{clientId:c.id});
  const paymentId=uuid();const refundId=uuid();
  await ok('RecordCashPayment',{id,expectedRevision:0,paymentId,amountCents:1000});
  await ok('RefundCashPayment',{id,expectedRevision:1,paymentId,refundId,amountCents:300},admin);
  assert.equal(Number((await summary(c.id)).netPaidCents),700);
  await ok('VoidCashRefund',{id,expectedRevision:2,refundId},admin);
  assert.equal(Number((await summary(c.id)).netPaidCents),1000);
  await ok('VoidCashPayment',{id,expectedRevision:3,paymentId},admin);
  assert.equal(Number((await summary(c.id)).netPaidCents),0);
});
