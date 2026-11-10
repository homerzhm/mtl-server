import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {OrderCreationService} from '../../lib/orders/service.js';
assert.equal(process.env.GCLOUD_PROJECT,'demo-mtl');
const pool=new pg.Pool({connectionString:'postgresql://postgres:test-only@127.0.0.1:15432/restaurant',max:8});
const actor={uid:'order-test',token:{staff:true,firebase:{sign_in_provider:'google.com'}}};
const service=new OrderCreationService(pool,()=>new Date('2030-01-01T00:00:00Z'));
let product;
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
async function query(operationName,variables={}) {
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const r=await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery',{method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName,variables})});
  const body=await r.json();assert.equal(r.ok&&!body.errors?.length,true,JSON.stringify(body));return body.data;
}
const input=(quantity=1)=>({id:randomUUID(),items:[{id:randomUUID(),productId:product,expectedRevision:0,quantity}],clientId:null,contactPhoneNumber:null,scheduledFor:'2030-06-01T18:00:00.000Z',allocations:[{minute:780,pigs:quantity}],depositRequiredCents:0,notes:null});
before(async()=>{
  const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const r=await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery',{method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName:'ListOrders',variables:{}})});
  const result=await r.json();assert.equal(!result.errors?.length,true,JSON.stringify(result));
  for(const migration of ['order-integrity.sql','order-paid-status.sql','order-roast-booking.sql'])await pool.query(await readFile(new URL(`../../../migrations/${migration}`,import.meta.url),'utf8'));
  product=randomUUID();await pool.query('INSERT INTO product(id,name,price_cents,is_active,is_lechon,revision,created_at) VALUES($1,\'Test pig\',100,true,true,0,now())',[product]);
});
after(async()=>{await pool.end();});
test('atomic creation, summaries, idempotent retry and payload ownership',async()=>{
  const v=input();const result=await service.create(actor,v);assert.equal(result.id,v.id);
  assert.deepEqual(await service.create(actor,v),result);
  await assert.rejects(service.create(actor,{...v,notes:'different'}),{code:'already-exists'});
  await assert.rejects(service.create({...actor,uid:'another'},v),{code:'already-exists'});
  const saved=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[v.id])).rows[0];
  assert.equal(saved.status,'CONFIRMED');assert.equal(saved.subtotal_cents,100);assert.equal(saved.final_total_cents,null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[v.id])).rows[0].n,0);
  const rows=(await query('ListStaffOrderSummaries')).staffOrderSummaries;
  const summary=rows.find(r=>r.id.replaceAll('-','')===v.id.replaceAll('-',''));assert.ok(summary,JSON.stringify(rows));assert.equal(Number(summary.pigCount),1);assert.equal(Number(summary.balanceCents),100);
  assert.equal((await query('FindStaffOrderByNumber',{number:saved.order_number})).staffOrderSummaries.length,1);
  assert.equal((await query('FindStaffOrdersByPhone',{phone:'+19999999999'})).staffOrderSummaries.length,0);
  const availability=await query('ListRoastAvailability',{start:'2030-06-01',end:'2030-07-01'});
  assert.equal(Number(availability.roastAvailabilities[0].booked),1);
  await assert.rejects(pool.query('UPDATE customer_order SET scheduled_for=now() WHERE id=$1',[v.id]),/ALLOCATION_AWARE_EDIT_REQUIRED/);
  await assert.rejects(pool.query('UPDATE order_item SET quantity=2 WHERE order_id=$1',[v.id]),/ALLOCATION_AWARE_EDIT_REQUIRED/);
  await pool.query("UPDATE customer_order SET status='CANCELLED',cancelled_at=now(),cancellation_total_cents=0 WHERE id=$1",[v.id]);
});
test('competing creations cannot both take the last roast place; cancellation and reopen share protection',async()=>{
  const first=input(17);await service.create(actor,first);
  const a=input(),b=input();const results=await Promise.allSettled([service.create(actor,a),service.create(actor,b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'resource-exhausted');
  const winner=results[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
  await pool.query("UPDATE customer_order SET status='CANCELLED',cancelled_at=now(),cancellation_total_cents=0 WHERE id=$1",[winner.id]);
  await service.create(actor,loser);
  await assert.rejects(pool.query("UPDATE customer_order SET status='CONFIRMED',cancelled_at=null WHERE id=$1",[winner.id]),/ROAST_CAPACITY/);
});
test('stale catalog and invalid allocation roll back every row',async()=>{
  const stale=input();stale.items[0].expectedRevision=5;await assert.rejects(service.create(actor,stale),/CATALOG_CHANGED/);
  const bad=input();bad.allocations=[];await assert.rejects(service.create(actor,bad),{code:'invalid-argument'});
  for(const v of [stale,bad])assert.equal((await pool.query('SELECT count(*)::int n FROM customer_order WHERE id=$1',[v.id])).rows[0].n,0);
});

test('multi-item snapshots, rollback after insert, and number collisions',async()=>{
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,is_lechon,revision,created_at) VALUES($1,'Addon',25,true,false,0,now())",[addon]);
  const v=input();v.scheduledFor='2030-06-02T18:00:00.000Z';v.items.push({id:randomUUID(),productId:addon,expectedRevision:0,quantity:2});
  await service.create(actor,v);
  const saved=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[v.id])).rows[0];assert.equal(saved.subtotal_cents,150);assert.equal(saved.item_count,2);
  const bad=input();bad.scheduledFor='2030-06-03T18:00:00.000Z';bad.items[0].id=v.items[0].id;
  await assert.rejects(service.create(actor,bad));
  assert.equal((await pool.query('SELECT count(*)::int n FROM customer_order WHERE id=$1',[bad.id])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_creation_request WHERE id=$1',[bad.id])).rows[0].n,0);
  let tries=0;
  const collisionService=new OrderCreationService(pool,()=>new Date('2030-01-01'),()=>++tries===1?saved.order_number:'ZZZZZZ');
  const collision=input();collision.scheduledFor='2030-06-04T18:00:00.000Z';await collisionService.create(actor,collision);assert.equal(tries,2);
});
test('non-lechon orders need no roast places and reject allocations; counts survive catalog changes',async()=>{
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,is_lechon,revision,created_at) VALUES($1,'Addon only',25,true,false,0,now())",[addon]);
  const v=input();v.items[0].productId=addon;v.allocations=[];await service.create(actor,v);
  const summary=(await query('ListStaffOrderSummaries')).staffOrderSummaries.find(r=>r.id.replaceAll('-','')===v.id.replaceAll('-',''));assert.equal(Number(summary.pigCount),0);
  await pool.query('UPDATE product SET is_lechon=true WHERE id=$1',[addon]);
  const again=(await query('ListStaffOrderSummaries')).staffOrderSummaries.find(r=>r.id.replaceAll('-','')===v.id.replaceAll('-',''));assert.equal(Number(again.pigCount),0);
});

test('overflow, deposit and non-lechon allocation validation leave no order',async()=>{
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,is_lechon,revision,created_at) VALUES($1,'High price',2147483647,true,false,0,now())",[addon]);
  for(const kind of ['overflow','deposit','allocation']) {
    const v=input();v.scheduledFor='2030-06-07T18:00:00.000Z';v.items[0].productId=addon;v.allocations=[];
    if(kind==='overflow')v.items[0].quantity=2;
    if(kind==='deposit'){v.items[0].productId=product;v.depositRequiredCents=101;v.allocations=[{minute:780,pigs:1}];}
    if(kind==='allocation')v.allocations=[{minute:780,pigs:1}];
    await assert.rejects(service.create(actor,v),{code:'invalid-argument'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM customer_order WHERE id=$1',[v.id])).rows[0].n,0);
  }
});
test('real callable authorizes staff and rejects unauthenticated creation',async()=>{
  const v=input();v.scheduledFor='2030-06-08T18:00:00.000Z';
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const call=async auth=>{
    const response=await fetch('http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/createStaffOrder',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({data:v})});return response.json();
  };
  assert.equal((await call(false)).error.status,'UNAUTHENTICATED');
  const saved=await call(true);assert.equal(saved.result?.id,v.id,JSON.stringify(saved));
  assert.deepEqual(await call(true),saved);
});

test('unallocated legacy lechon creation and reopening remain blocked without an activation gate',async()=>{
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const id=randomUUID();
    await db.query("INSERT INTO customer_order(id,order_number,subtotal_cents,item_count,created_at,updated_at) VALUES($1,'ZEGACY',100,1,now(),now())",[id]);
    await assert.rejects(db.query("INSERT INTO order_item(id,order_id,product_id,product_name,catalog_unit_price_cents,unit_price_cents,quantity,created_at) VALUES($1,$2,$3,'Legacy pig',100,100,1,now())",[randomUUID(),id,product]),/ALLOCATION_AWARE_CREATE_REQUIRED/);
  } finally { await db.query('ROLLBACK');db.release(); }
  const legacy=randomUUID();
  await pool.query("INSERT INTO customer_order(id,order_number,subtotal_cents,item_count,status,cancelled_at,cancellation_total_cents,created_at,updated_at) VALUES($1,'ZEGACY',100,1,'CANCELLED',now(),0,now(),now())",[legacy]);
  await pool.query("INSERT INTO order_item(id,order_id,product_id,product_name,catalog_unit_price_cents,unit_price_cents,quantity,created_at) VALUES($1,$2,$3,'Legacy pig',100,100,1,now())",[randomUUID(),legacy,product]);
  await assert.rejects(pool.query("UPDATE customer_order SET status='CONFIRMED',cancelled_at=null,cancellation_total_cents=null WHERE id=$1",[legacy]),/ALLOCATION_AWARE_REOPEN_REQUIRED/);
  assert.equal((await pool.query('SELECT status FROM customer_order WHERE id=$1',[legacy])).rows[0].status,'CANCELLED');
});

test('phone summary pagination passes 100 rows and ledger aggregates do not multiply',async()=>{
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,is_lechon,revision,created_at) VALUES($1,'Summary item',1000,true,false,0,now())",[addon]);
  const ids=[];
  for(let n=0;n<101;n++) {
    const v=input();v.items[0].productId=addon;v.allocations=[];v.contactPhoneNumber='+14165550124';v.scheduledFor='2030-06-09T18:00:00.000Z';
    await service.create(actor,v);ids.push(v.id);
  }
  const first=(await query('FindStaffOrdersByPhone',{phone:'+14165550124'})).staffOrderSummaries;
  const next=(await query('FindStaffOrdersByPhone',{phone:'+14165550124',offset:100})).staffOrderSummaries;
  assert.equal(first.length,100);assert.equal(next.length,1);assert.equal(new Set([...first,...next].map(r=>r.id)).size,101);
  const p1=randomUUID(),p2=randomUUID();
  await pool.query("INSERT INTO payment(id,order_id,amount_cents,method,status,received_at,created_at) VALUES($1,$3,100,'CASH','SUCCEEDED',now(),now()),($2,$3,200,'CASH','SUCCEEDED',now(),now())",[p1,p2,ids[0]]);
  await pool.query("INSERT INTO refund(id,payment_id,amount_cents,status,created_at) VALUES($1,$3,30,'SUCCEEDED',now()),($2,$4,40,'SUCCEEDED',now())",[randomUUID(),randomUUID(),p1,p2]);
  const number=(await pool.query('SELECT order_number FROM customer_order WHERE id=$1',[ids[0]])).rows[0].order_number;
  const row=(await query('FindStaffOrderByNumber',{number})).staffOrderSummaries[0];
  assert.equal(Number(row.netPaidCents),230);assert.equal(Number(row.balanceCents),770);assert.equal(row.isEstimate,true);
});


test('dedicated runtime creates with SELECT/INSERT and helper EXECUTE only',async()=>{
  await pool.query('CREATE ROLE orders_runtime_test NOLOGIN');
  await pool.query('GRANT USAGE ON SCHEMA public TO orders_runtime_test');
  await pool.query('GRANT SELECT ON product,client,customer_order,order_item,order_roast_allocation,order_creation_request TO orders_runtime_test');
  await pool.query('GRANT INSERT ON customer_order,order_item,order_roast_allocation,order_creation_request,order_audit_event TO orders_runtime_test');
  await pool.query('GRANT EXECUTE ON FUNCTION public.lock_order_creation_sources(uuid[],uuid) TO orders_runtime_test');
  const restricted=new pg.Pool({connectionString:'postgresql://postgres:test-only@127.0.0.1:15432/restaurant',max:1,options:'-c role=orders_runtime_test'});
  try {
    await assert.rejects(restricted.query('SELECT id FROM product FOR SHARE'),/permission denied/);
    const client=randomUUID();
    await pool.query("INSERT INTO client(id,phone_number,revision,created_at) VALUES($1,'+14165550998',0,now())",[client]);
    const v=input();v.scheduledFor='2030-06-10T18:00:00.000Z';v.clientId=client;
    const runtime=new OrderCreationService(restricted,()=>new Date('2030-01-01'));
    assert.deepEqual(await runtime.create(actor,v),{id:v.id});
    assert.deepEqual(await runtime.create(actor,v),{id:v.id});
  } finally {
    await restricted.end();
    await pool.query('DROP OWNED BY orders_runtime_test');
    await pool.query('DROP ROLE orders_runtime_test');
  }
});
