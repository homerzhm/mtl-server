import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {OrderCreationService} from '../../lib/orders/service.js';
import {BookingConfigurationService,BookingAvailabilityService} from '../../lib/orders/capacity.js';
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
const lechon=randomUUID();
const input=(quantity=1)=>({id:randomUUID(),items:[{id:randomUUID(),productId:product,expectedRevision:0,quantity}],clientId:null,contactPhoneNumber:null,scheduledFor:'2030-06-01T18:00:00.000Z',expectedSettingsRevision:0,expectedGroups:[{id:lechon,expectedRevision:0}],allocations:[{groupId:lechon,blockMinute:780,quantity:quantity}],depositRequiredCents:0,notes:null});
before(async()=>{
  const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const r=await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery',{method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName:'ListOrders',variables:{}})});
  const result=await r.json();assert.equal(!result.errors?.length,true,JSON.stringify(result));
  for(const migration of ['order-integrity.sql','order-paid-status.sql','order-capacity-booking.sql','order-actions.sql'])await pool.query(await readFile(new URL(`../../../migrations/${migration}`,import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/order-actions.sql',import.meta.url),'utf8')); // Repeatable upgrade.
  assert.equal((await pool.query('SELECT count(*)::int n FROM capacity_group')).rows[0].n,0);
  // Test fixtures use the admin API; production migrations create no groups.
  await configuration.change(admin,{action:'CREATE_GROUP',id:lechon,code:'LECHON',name:'Lechon',capacityPerBlock:18});
  await configuration.change(admin,{action:'CREATE_GROUP',id:belly,code:'PORK_BELLY',name:'Pork belly',capacityPerBlock:4});
  product=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'Test pig',100,true,$2,0,now())",[product,lechon]);
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
  const summary=rows.find(r=>r.id.replaceAll('-','')===v.id.replaceAll('-',''));assert.ok(summary,JSON.stringify(rows));assert.equal(Number((await query('ListOrderCapacitySummaries',{id:v.id})).orderCapacitySummaries[0].quantity),1);assert.equal(Number(summary.balanceCents),100);
  assert.equal((await query('FindStaffOrderByNumber',{number:saved.order_number})).staffOrderSummaries.length,1);
  assert.equal((await query('FindStaffOrdersByPhone',{phone:'+19999999999'})).staffOrderSummaries.length,0);
  const availability=await new BookingAvailabilityService(pool).get(actor,{day:'2030-06-01'});
  assert.equal(Number(availability.blocks.find(b=>b.groupId===lechon&&b.blockMinute===780).booked),1);
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
  await assert.rejects(pool.query("UPDATE customer_order SET status='CONFIRMED',cancelled_at=null WHERE id=$1",[winner.id]),/GROUP_CAPACITY/);
});
test('stale catalog and invalid allocation roll back every row',async()=>{
  const stale=input();stale.items[0].expectedRevision=5;await assert.rejects(service.create(actor,stale),/CATALOG_CHANGED/);
  const bad=input();bad.allocations=[];await assert.rejects(service.create(actor,bad),{code:'invalid-argument'});
  for(const v of [stale,bad])assert.equal((await pool.query('SELECT count(*)::int n FROM customer_order WHERE id=$1',[v.id])).rows[0].n,0);
});

test('multi-item snapshots, rollback after insert, and number collisions',async()=>{
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'Addon',25,true,NULL,0,now())",[addon]);
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
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'Addon only',25,true,NULL,0,now())",[addon]);
  const v=input();v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];await service.create(actor,v);
  assert.equal((await query('ListOrderCapacitySummaries',{id:v.id})).orderCapacitySummaries.length,0);
  await pool.query("UPDATE product SET capacity_group_id=$2,revision=revision+1 WHERE id=$1",[addon,lechon]);
  assert.equal((await query('ListOrderCapacitySummaries',{id:v.id})).orderCapacitySummaries.length,0);
});

test('overflow, deposit and non-lechon allocation validation leave no order',async()=>{
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'High price',2147483647,true,NULL,0,now())",[addon]);
  for(const kind of ['overflow','deposit','allocation']) {
    const v=input();v.scheduledFor='2030-06-07T18:00:00.000Z';v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];
    if(kind==='overflow')v.items[0].quantity=2;
    if(kind==='deposit'){v.items[0].productId=product;v.expectedGroups=[{id:lechon,expectedRevision:0}];v.depositRequiredCents=101;v.allocations=[{groupId:lechon,blockMinute:780,quantity:1}];}
    if(kind==='allocation')v.allocations=[{groupId:lechon,blockMinute:780,quantity:1}];
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
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'Summary item',1000,true,NULL,0,now())",[addon]);
  const ids=[];
  for(let n=0;n<101;n++) {
    const v=input();v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];v.contactPhoneNumber='+14165550124';v.scheduledFor='2030-06-09T18:00:00.000Z';
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
  await pool.query('GRANT SELECT ON product,client,customer_order,order_item,order_capacity_allocation,order_creation_request,booking_settings,capacity_group TO orders_runtime_test');
  await pool.query('GRANT INSERT ON customer_order,order_item,order_capacity_allocation,order_creation_request,order_audit_event TO orders_runtime_test');
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
  const addon=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'Cash test',100,true,NULL,0,now())",[addon]);
  const v=input();v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];await service.create(actor,v);return v.id;
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
    GRANT SELECT ON customer_order,payment,refund,order_action_request,order_capacity_allocation,order_item,product,booking_settings,capacity_group TO action_runtime;
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

const belly=randomUUID();
const admin={uid:'booking-admin',token:{staff:true,admin:true,firebase:{sign_in_provider:'google.com'}}};
const configuration=new BookingConfigurationService(pool);
const availabilityService=new BookingAvailabilityService(pool);
async function groupProduct(groupId,name='Grouped product') {
  const id=randomUUID();
  await pool.query('INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,$2,100,true,$3,0,now())',[id,name,groupId]);return id;
}
async function configuredInput(day,products) {
  const v=input();v.scheduledFor=day+'T22:00:00.000Z';v.items=products.map(([productId,quantity])=>({id:randomUUID(),productId,quantity,expectedRevision:0}));
  v.expectedSettingsRevision=(await pool.query("SELECT revision FROM booking_settings WHERE id='default'")).rows[0].revision;
  const groups=(await pool.query('SELECT DISTINCT g.id,g.revision FROM product p JOIN capacity_group g ON g.id=p.capacity_group_id WHERE p.id=ANY($1::uuid[])',[v.items.map(i=>i.productId)])).rows;
  v.expectedGroups=groups.map(g=>({id:g.id,expectedRevision:g.revision}));v.allocations=[];return v;
}
const cancel=id=>pool.query("UPDATE customer_order SET status='CANCELLED',cancelled_at=now(),cancellation_total_cents=0 WHERE id=$1",[id]);
const settings=async()=> (await pool.query("SELECT * FROM booking_settings WHERE id='default'")).rows[0];
const setBlocks=async blockMinutes=>configuration.change(admin,{action:'UPDATE_SETTINGS',expectedRevision:(await settings()).revision,blockMinutes});
async function updateGroup(id,patch={}) {
  const g=(await pool.query('SELECT * FROM capacity_group WHERE id=$1',[id])).rows[0];
  return configuration.change(admin,{action:'UPDATE_GROUP',id,expectedRevision:g.revision,name:g.name,capacityPerBlock:g.capacity_per_block,archived:g.archived,...patch});
}
test('independent pools accept 18 lechon and 4 belly, products share limits and mixed splits respect pickup',async()=>{
  const bp=await groupProduct(belly),bp2=await groupProduct(belly);
  const v=await configuredInput('2030-08-01',[[product,18],[bp,2],[bp2,2]]);
  v.allocations=[{groupId:lechon,blockMinute:780,quantity:18},{groupId:belly,blockMinute:780,quantity:4}];await service.create(actor,v);
  for(const [p,g] of [[product,lechon],[bp,belly]]) {
    const full=await configuredInput('2030-08-01',[[p,1]]);full.allocations=[{groupId:g,blockMinute:780,quantity:1}];
    await assert.rejects(service.create(actor,full),/GROUP_CAPACITY/);
  }
  const rows=(await availabilityService.get(actor,{day:'2030-08-01'})).blocks;
  assert.equal(rows.find(r=>r.groupId===belly&&r.blockMinute===780).remaining,'0');
  assert.equal(rows.find(r=>r.groupId===belly&&r.blockMinute===660).remaining,'4');
  const split=await configuredInput('2030-08-02',[[product,2],[bp,2]]);
  split.allocations=[{groupId:lechon,blockMinute:660,quantity:1},{groupId:lechon,blockMinute:780,quantity:1},{groupId:belly,blockMinute:930,quantity:2}];
  await assert.rejects(service.create(actor,{...split,scheduledFor:'2030-08-02T18:00:00Z'}),/PICKUP_EXPIRED/);
  await service.create(actor,split);
  const summaries=(await query('ListOrderCapacitySummaries',{id:split.id})).orderCapacitySummaries;
  assert.equal(summaries.length,2);assert.deepEqual(summaries.map(s=>Number(s.quantity)),[2,2]);
  const saved=(await pool.query('SELECT order_number FROM customer_order WHERE id=$1',[split.id])).rows[0];
  const summary=(await query('FindStaffOrderByNumber',{number:saved.order_number})).staffOrderSummaries[0];
  assert.deepEqual(summary.groupQuantities.map(g=>g.quantity),['2','2']);assert.equal(Number(summary.balanceCents),400);
});
test('settings/group revisions, reservation conflicts, safe edits and saved retry identities',async()=>{
  const gp=await groupProduct(belly),v=await configuredInput('2030-08-03',[[gp,4]]);
  v.allocations=[{groupId:belly,blockMinute:780,quantity:4}];await service.create(actor,v);
  await assert.rejects(setBlocks([660,930,1080]),/BOOKING_BLOCK_IN_USE/);
  await assert.rejects(updateGroup(belly,{capacityPerBlock:3}),/GROUP_CAPACITY_IN_USE/);
  await assert.rejects(updateGroup(belly,{archived:true}),/GROUP_HAS_PRODUCTS/);
  const s=await settings();await setBlocks([...s.block_minutes,1140]);
  await assert.rejects(configuration.change(admin,{action:'UPDATE_SETTINGS',expectedRevision:s.revision,blockMinutes:s.block_minutes}),/BOOKING_CONFIGURATION_CONFLICT/);
  const stale=await configuredInput('2030-08-04',[[gp,1]]);stale.allocations=[{groupId:belly,blockMinute:780,quantity:1}];stale.expectedSettingsRevision=s.revision;
  await assert.rejects(service.create(actor,stale),/BOOKING_CONFIGURATION_CHANGED/);
  const fresh=await configuredInput('2030-08-04',[[gp,1]]);fresh.allocations=stale.allocations;
  await updateGroup(belly,{name:'Belly renamed'});
  await assert.rejects(service.create(actor,fresh),/BOOKING_CONFIGURATION_CHANGED/);
  assert.deepEqual(await service.create(actor,v),{id:v.id}); // Replay despite now-stale revisions.
  const snapshot=(await pool.query('SELECT capacity_group_name_snapshot FROM order_item WHERE order_id=$1',[v.id])).rows[0];assert.equal(snapshot.capacity_group_name_snapshot,'Pork belly');
  await setBlocks(s.block_minutes);
});
test('reassignment and archival preserve booked groups; cancelled removed blocks cannot reopen',async()=>{
  const id=randomUUID();await configuration.change(admin,{action:'CREATE_GROUP',id,code:'ARCHIVE_TEST',name:'Archive test',capacityPerBlock:4});
  const p=await groupProduct(id),v=await configuredInput('2030-08-05',[[p,2]]);v.allocations=[{groupId:id,blockMinute:780,quantity:2}];await service.create(actor,v);
  await pool.query('UPDATE product SET capacity_group_id=NULL,revision=revision+1 WHERE id=$1',[p]);
  await updateGroup(id,{archived:true});
  await cancel(v.id);await pool.query("UPDATE customer_order SET status='CONFIRMED',cancelled_at=NULL,cancellation_total_cents=NULL WHERE id=$1",[v.id]);
  assert.equal((await pool.query('SELECT group_id FROM order_capacity_allocation WHERE order_id=$1',[v.id])).rows[0].group_id,id);
  await assert.rejects(groupProduct(id),/GROUP_UNAVAILABLE/);
  const snapshot=(await query('ListOrderCapacitySummaries',{id:v.id})).orderCapacitySummaries[0];assert.equal(snapshot.groupName,'Archive test');
  // Use a new unoccupied block so other test reservations do not interfere.
  const original=(await settings()).block_minutes;await setBlocks([...original,1155]);
  const p2=await groupProduct(belly),removed=await configuredInput('2030-08-06',[[p2,1]]);removed.scheduledFor='2030-08-06T23:30:00Z';removed.allocations=[{groupId:belly,blockMinute:1155,quantity:1}];
  await service.create(actor,removed);await cancel(removed.id);await setBlocks(original);
  await assert.rejects(pool.query("UPDATE customer_order SET status='CONFIRMED',cancelled_at=NULL,cancellation_total_cents=NULL WHERE id=$1",[removed.id]),/BOOKING_BLOCK_UNAVAILABLE/);
});
test('competing configuration edits and bookings cannot invalidate capacity',async()=>{
  const id=randomUUID();await configuration.change(admin,{action:'CREATE_GROUP',id,code:'RACE_TEST',name:'Race test',capacityPerBlock:4});
  const p=await groupProduct(id),v=await configuredInput('2030-08-07',[[p,4]]);v.allocations=[{groupId:id,blockMinute:780,quantity:4}];
  const outcomes=await Promise.allSettled([service.create(actor,v),updateGroup(id,{capacityPerBlock:3})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const booked=(await pool.query("SELECT COALESCE(sum(a.quantity),0)::int n FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id WHERE a.group_id=$1 AND o.status<>'CANCELLED'",[id])).rows[0].n;
  const limit=(await pool.query('SELECT capacity_per_block FROM capacity_group WHERE id=$1',[id])).rows[0].capacity_per_block;assert.ok(booked<=limit);
});
test('configuration callables authorize before dependencies and restricted grants support config and availability',async()=>{
  await assert.rejects(configuration.change(actor,{action:'UPDATE_SETTINGS',expectedRevision:0,blockMinutes:[660]}),{code:'permission-denied'});
  const endpoint='http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/';
  for(const name of ['manageBookingConfiguration','getBookingAvailability']) {
    const denied=await fetch(endpoint+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{}})});
    assert.equal((await denied.json()).error.status,'UNAUTHENTICATED');
  }
  const token=`${encode({alg:'none'})}.${encode({sub:admin.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,admin:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const request={action:'CREATE_GROUP',id:randomUUID(),code:'CALLABLE_GROUP',name:'Callable group',capacityPerBlock:2};
  const response=await fetch(endpoint+'manageBookingConfiguration',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({data:request})});
  assert.equal((await response.json()).result.id,request.id);
  const read=await fetch(endpoint+'getBookingAvailability',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({data:{day:'2030-08-01'}})});
  assert.equal((await read.json()).result.blocks.length>0,true);
  await pool.query(`CREATE ROLE booking_runtime NOLOGIN;
    GRANT USAGE ON SCHEMA public TO booking_runtime;
    GRANT SELECT ON booking_settings,capacity_group,product,order_capacity_allocation,customer_order TO booking_runtime;
    GRANT INSERT ON capacity_group TO booking_runtime;
    GRANT UPDATE(block_minutes,revision,updated_at,updated_by) ON booking_settings TO booking_runtime;
    GRANT UPDATE(name,capacity_per_block,archived,revision,updated_at,updated_by) ON capacity_group TO booking_runtime`);
  const restricted=new pg.Pool({connectionString:'postgresql://postgres:test-only@127.0.0.1:15432/restaurant',options:'-c role=booking_runtime',max:2});
  try {
    await assert.rejects(restricted.query('UPDATE product SET name=name'),/permission denied/);
    const runtime=new BookingConfigurationService(restricted),s=await settings();
    await runtime.change(admin,{action:'UPDATE_SETTINGS',expectedRevision:s.revision,blockMinutes:s.block_minutes});
    await runtime.change(admin,{action:'UPDATE_GROUP',id:request.id,expectedRevision:0,name:'Updated',capacityPerBlock:3,archived:false});
    assert.ok((await new BookingAvailabilityService(restricted).get(actor,{day:'2030-08-01'})).blocks.length);
  } finally {await restricted.end();await pool.query('DROP OWNED BY booking_runtime; DROP ROLE booking_runtime');}
});
test('configuration reads and availability paginate at 100 with stable ordering',async()=>{
  for(let n=0;n<101;n++) await configuration.change(admin,{action:'CREATE_GROUP',id:randomUUID(),code:'PAGE_'+n,name:'Page '+n,capacityPerBlock:1});
  const all=[];let offset=0;
  do {const page=await availabilityService.get(actor,{day:'2030-09-01',offset});assert.ok(page.blocks.length<=100);all.push(...page.blocks);offset=page.nextOffset;} while(offset!==null);
  assert.ok(all.length>100);assert.equal(new Set(all.map(r=>r.groupId+':'+r.blockMinute)).size,all.length);
  const listed=(await query('ListCapacityGroups')).capacityGroups,next=(await query('ListCapacityGroups',{offset:100})).capacityGroups;assert.equal(listed.length,100);assert.ok(next.length>0);assert.equal(new Set([...listed,...next].map(g=>g.id)).size,listed.length+next.length);
  assert.deepEqual((await query('GetBookingSettings')).bookingSettings.blockMinutes,[660,780,930,1080]);
});

test('database guards reject allocation bypasses and migration preserves explicit groups and saved edits',async()=>{
  await assert.rejects(pool.query("UPDATE booking_settings SET block_minutes=ARRAY[661],revision=revision+1 WHERE id='default'"),/BOOKING_CONFIGURATION_INVALID/);
  await assert.rejects(pool.query('DELETE FROM capacity_group WHERE id=$1',[belly]),/ARCHIVE_GROUP_INSTEAD/);
  await assert.rejects(pool.query('UPDATE capacity_group SET code=$2,revision=revision+1 WHERE id=$1',[belly,'OTHER_CODE']),/BOOKING_CONFIGURATION_CONFLICT/);
  const existing=(await pool.query('SELECT id FROM order_capacity_allocation LIMIT 1')).rows[0].id;
  await assert.rejects(pool.query('DELETE FROM order_capacity_allocation WHERE id=$1',[existing]),/ALLOCATION_AWARE_EDIT_REQUIRED/);
  const db=await pool.connect(),id=randomUUID();
  try {
    await db.query('BEGIN');
    await db.query("INSERT INTO customer_order(id,order_number,subtotal_cents,item_count,booking_managed,scheduled_for,created_at,updated_at) VALUES($1,'BYPA55',100,1,true,'2030-10-01T18:00:00Z',now(),now())",[id]);
    await db.query("INSERT INTO order_item(id,order_id,product_id,product_name,capacity_group_id,capacity_group_name_snapshot,catalog_unit_price_cents,unit_price_cents,quantity,created_at) VALUES($1,$2,$3,'Incomplete allocation',$4,'Lechon',100,100,1,now())",[randomUUID(),id,product,lechon]);
    await assert.rejects(db.query('COMMIT'),/GROUP_ALLOCATION_INVALID/);
  } finally {await db.query('ROLLBACK');db.release();}
  assert.equal((await pool.query('SELECT count(*)::int n FROM customer_order WHERE id=$1',[id])).rows[0].n,0);
  const before=await settings(),group=(await pool.query('SELECT * FROM capacity_group WHERE id=$1',[belly])).rows[0];
  await pool.query(await readFile(new URL('../../../migrations/order-capacity-booking.sql',import.meta.url),'utf8'));
  assert.deepEqual(await settings(),before);assert.deepEqual((await pool.query('SELECT * FROM capacity_group WHERE id=$1',[belly])).rows[0],group);
});

async function connector(operationName,variables,claims,mutation=false) {
  const token=`${encode({alg:'none'})}.${encode({sub:'connector-capacity',aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})}.`;
  const result=await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:execute'+(mutation?'Mutation':'Query'),{
    method:'POST',headers:{'Content-Type':'application/json',...(claims?{'x-firebase-auth-token':token}:{})},body:JSON.stringify({operationName,variables})});
  const body=await result.json();return {ok:result.ok&&!body.errors?.length,body};
}
test('connector product assignments enforce admin, revision and archival; configuration reads enforce staff policy',async()=>{
  const draft={id:randomUUID(),name:'Connector group',priceCents:100,isActive:true,capacityGroupId:belly};
  const made=await connector('CreateProduct',draft,admin.token,true);assert.equal(made.ok,true,JSON.stringify(made.body));
  const edit={...draft,capacityGroupId:lechon,expectedRevision:0};
  assert.equal((await connector('UpdateProduct',edit,actor.token,true)).ok,false);
  const changes=await Promise.all([connector('UpdateProduct',edit,admin.token,true),connector('UpdateProduct',{...edit,capacityGroupId:null},admin.token,true)]);
  assert.equal(changes.filter(r=>r.ok).length,1);
  const saved=await connector('GetProduct',{id:draft.id},{firebase:{sign_in_provider:'password'}});assert.equal(saved.ok,true);assert.equal(saved.body.data.product.revision,1);
  const archived=(await pool.query('SELECT id FROM capacity_group WHERE archived LIMIT 1')).rows[0].id;
  assert.equal((await connector('UpdateProduct',{...draft,capacityGroupId:archived,expectedRevision:1},admin.token,true)).ok,false);
  for(const op of ['GetBookingSettings','ListCapacityGroups','ListOrderCapacityAllocations','ListOrderCapacitySummaries']) {
    const vars=op.startsWith('ListOrder')?{id:randomUUID()}:{};
    for(const claims of [null,{firebase:{sign_in_provider:'google.com'}},{staff:'true',firebase:{sign_in_provider:'google.com'}},{staff:true,firebase:{sign_in_provider:'password'}}])
      assert.equal((await connector(op,vars,claims)).ok,false,op);
    for(const claims of [actor.token,{admin:true,firebase:{sign_in_provider:'google.com'}}])assert.equal((await connector(op,vars,claims)).ok,true,op);
  }
});
