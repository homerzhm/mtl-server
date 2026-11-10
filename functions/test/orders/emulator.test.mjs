import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {OrderCreationService} from '../../lib/orders/service.js';
import {OrderActionService} from '../../lib/orders/actions.js';
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
  for(const migration of ['order-integrity.sql','order-paid-status.sql','order-roast-booking.sql','order-actions.sql'])await pool.query(await readFile(new URL(`../../../migrations/${migration}`,import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/order-actions.sql',import.meta.url),'utf8')); // Repeatable upgrade.
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

const actions=new OrderActionService(pool);
const action=(id,expectedRevision,kind,amountCents=null)=>({requestId:randomUUID(),id,expectedRevision,action:kind,amountCents});
async function actionOrder() {
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,is_lechon,revision,created_at) VALUES($1,'Cash test',100,true,false,0,now())",[addon]);
  const v=input();v.items[0].productId=addon;v.allocations=[];await service.create(actor,v);return v.id;
}
test('cash overpayment, finalization and pickup are audited, atomic and retry safe',async()=>{
  const id=await actionOrder();
  await assert.rejects(actions.perform(actor,action(id,0,'PAID')),/ORDER_BALANCE_DUE/);
  await assert.rejects(actions.perform(actor,action(id,0,'PICKUP')),/ORDER_NOT_PAID/);
  const pay=action(id,0,'PAYMENT',150);
  await actions.perform(actor,pay);await actions.perform(actor,pay); // lost response retry
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[id])).rows[0].n,1);
  await assert.rejects(actions.perform({...actor,uid:'other'},pay),/REQUEST_CONFLICT/);
  await assert.rejects(actions.perform(actor,{...pay,amountCents:151}),/REQUEST_CONFLICT/);
  const paid=action(id,1,'PAID');await actions.perform(actor,paid);await actions.perform(actor,paid);
  const saved=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[id])).rows[0];
  assert.equal(saved.final_total_cents,100);assert.equal(saved.status,'PAID');
  await assert.rejects(actions.perform(actor,action(id,2,'PAYMENT',1)),/ORDER_LOCKED/);
  await actions.perform(actor,action(id,2,'PICKUP'));
  await actions.perform(actor,pay); // Committed request still replays after later transitions.
  const pickupAudit=(await pool.query('SELECT changes FROM order_audit_event WHERE order_id=$1 AND order_revision=3',[id])).rows[0].changes;
  assert.equal(pickupAudit.before.completedAt,null);
  assert.equal(pickupAudit.after.completedAt,(await pool.query('SELECT completed_at FROM customer_order WHERE id=$1',[id])).rows[0].completed_at.toISOString());
  await assert.rejects(actions.perform(actor,action(id,3,'PAYMENT',1)),/ORDER_LOCKED/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_audit_event WHERE order_id=$1 AND actor_uid=$2",[id,actor.uid])).rows[0].n,4);
  assert.equal((await query('GetOrder',{id})).order.status,'COMPLETED');
  assert.equal(Number((await query('GetOrder',{id})).financials[0].balanceCents),-50);
});
test('Paid uses discounted totals and net successful ledger entries, preserving agreed totals',async()=>{
  const id=await actionOrder();
  const first=action(id,0,'PAYMENT',60),second=action(id,1,'PAYMENT',40);
  await actions.perform(actor,first);await actions.perform(actor,second);
  await pool.query('UPDATE customer_order SET discount_cents=20,final_total_cents=90 WHERE id=$1',[id]);
  await assert.rejects(actions.perform(actor,action(id,2,'PAID')),/ORDER_TOTAL_REVIEW/);
  assert.equal((await pool.query('SELECT final_total_cents FROM customer_order WHERE id=$1',[id])).rows[0].final_total_cents,90);
  await pool.query('UPDATE customer_order SET final_total_cents=NULL WHERE id=$1',[id]);
  const refund=randomUUID();
  await pool.query("INSERT INTO refund(id,payment_id,amount_cents,status,created_at) VALUES($1,$2,30,'SUCCEEDED',now()),($3,$2,5,'VOIDED',now())",[refund,first.requestId,randomUUID()]);
  await assert.rejects(actions.perform(actor,action(id,2,'PAID')),/ORDER_BALANCE_DUE/);
  await pool.query("UPDATE refund SET status='VOIDED' WHERE id=$1",[refund]);
  await actions.perform(actor,action(id,2,'PAID'));
  assert.equal((await pool.query('SELECT final_total_cents FROM customer_order WHERE id=$1',[id])).rows[0].final_total_cents,80);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[id])).rows[0].n,2);
});
test('competing actions cannot bypass revision, insert twice or partially commit',async()=>{
  const id=await actionOrder(),a=action(id,0,'PAYMENT',100),b=action(id,0,'PAYMENT',100);
  const result=await Promise.allSettled([actions.perform(actor,a),actions.perform(actor,b)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.match(result.find(r=>r.status==='rejected').reason.message,/ORDER_CONFLICT/);
  // Force the final request insert to fail after order/payment/audit writes.
  await pool.query(`CREATE OR REPLACE FUNCTION fail_action_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback test'; END $$;
    CREATE TRIGGER fail_action_test BEFORE INSERT ON order_action_request FOR EACH ROW EXECUTE FUNCTION fail_action_test()`);
  const failed=action(id,1,'PAYMENT',25);
  try {await assert.rejects(actions.perform(actor,failed),/rollback test/);}
  finally {await pool.query('DROP TRIGGER fail_action_test ON order_action_request; DROP FUNCTION fail_action_test()');}
  assert.equal((await pool.query('SELECT revision FROM customer_order WHERE id=$1',[id])).rows[0].revision,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE id=$1',[failed.requestId])).rows[0].n,0);
  await actions.perform(actor,failed);
});
test('native status/payment guards reject old mutation bypasses, including concurrent payment and Paid',async()=>{
  const id=await actionOrder();
  await assert.rejects(pool.query("UPDATE customer_order SET status='PAID' WHERE id=$1",[id]),/ORDER_BALANCE_DUE/);
  await assert.rejects(pool.query("UPDATE customer_order SET status='COMPLETED',completed_at=now() WHERE id=$1",[id]),/ORDER_NOT_PAID/);
  await actions.perform(actor,action(id,0,'PAYMENT',100));
  await assert.rejects(pool.query("UPDATE customer_order SET status='PAID' WHERE id=$1",[id]),/ORDER_TOTAL_REVIEW/);
  const result=await Promise.allSettled([actions.perform(actor,action(id,1,'PAID')),actions.perform(actor,action(id,1,'PAYMENT',10))]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const saved=(await pool.query('SELECT status,revision FROM customer_order WHERE id=$1',[id])).rows[0];
  if(saved.status==='CONFIRMED')await actions.perform(actor,action(id,saved.revision,'PAID'));
  await assert.rejects(pool.query("INSERT INTO payment(id,order_id,amount_cents,method,status,received_at,created_at) VALUES($1,$2,10,'CASH','SUCCEEDED',now(),now())",[randomUUID(),id]),/ORDER_LOCKED/);
});
test('order action callable rejects anonymous callers and enforces actual restricted runtime grants',async()=>{
  const endpoint='http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/updateStaffOrder';
  const denied=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{}})});
  assert.equal((await denied.json()).error.status,'UNAUTHENTICATED');
  const callableID=await actionOrder();
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const request=action(callableID,0,'PAYMENT',125);
  for(let attempt=0;attempt<2;attempt++) {
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({data:request})});
    const body=await response.json();assert.equal(body.result.id,callableID,JSON.stringify(body));
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[callableID])).rows[0].n,1);
  const native=input();native.scheduledFor='2030-07-01T18:00:00.000Z';await service.create(actor,native);const id=native.id;
  await pool.query(`CREATE ROLE action_runtime LOGIN PASSWORD 'test-only';
    GRANT USAGE ON SCHEMA public TO action_runtime;
    GRANT SELECT ON customer_order,payment,refund,order_action_request,order_roast_allocation,order_item,product TO action_runtime;
    GRANT UPDATE(revision,status,final_total_cents,completed_at,updated_at) ON customer_order TO action_runtime;
    GRANT INSERT ON payment,order_action_request,order_audit_event TO action_runtime`);
  const restricted=new pg.Pool({connectionString:'postgresql://action_runtime:test-only@127.0.0.1:15432/restaurant',max:2});
  try {
    const service=new OrderActionService(restricted);
    await service.perform(actor,action(id,0,'PAYMENT',100));
    await service.perform({...actor,token:{admin:true,firebase:{sign_in_provider:'google.com'}}},action(id,1,'PAID'));
    await service.perform(actor,action(id,2,'PICKUP'));
    for(const token of [{staff:'true'}, {staff:true,firebase:{sign_in_provider:'password'}},{}])
      await assert.rejects(service.perform({uid:'bad',token},action(id,3,'PAYMENT',10)),{code:'permission-denied'});
  } finally {await restricted.end();}
});
