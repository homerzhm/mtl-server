import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {OrderCreationService} from '../../lib/orders/service.js';
import {BookingConfigurationService,BookingAvailabilityService} from '../../lib/orders/capacity.js';
import {OrderEditService} from '../../lib/orders/edits.js';
import {OrderActionService} from '../../lib/orders/actions.js';
import {HistoricalOrderImportService} from '../../lib/orders/historical-import.js';
assert.equal(process.env.GCLOUD_PROJECT,'demo-mtl');
const pool=new pg.Pool({connectionString:'postgresql://postgres:test-only@127.0.0.1:15432/restaurant',max:8});
const actor={uid:'order-test',token:{staff:true,firebase:{sign_in_provider:'google.com'}}};
const service=new OrderCreationService(pool,()=>new Date('2030-01-01T00:00:00Z'));
let product;
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
async function executeConnector(kind,operationName,variables,claims={staff:true}) {
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',...claims,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  return fetch(`http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:execute${kind}`,{method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName,variables})});
}
async function query(operationName,variables={},claims) {
  const r=await executeConnector('Query',operationName,variables,claims);
  const body=await r.json();assert.equal(r.ok&&!body.errors?.length,true,JSON.stringify(body));return body.data;
}
const lechon=randomUUID();
const input=(quantity=1)=>({id:randomUUID(),items:[{id:randomUUID(),productId:product,expectedRevision:0,quantity}],clientId:null,contactPhoneNumber:null,scheduledFor:'2030-06-01T18:00:00.000Z',expectedSettingsRevision:0,expectedGroups:[{id:lechon,expectedRevision:0}],allocations:[{groupId:lechon,blockMinute:780,quantity:quantity}],depositRequiredCents:0,notes:null});
before(async()=>{
  const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const r=await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery',{method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName:'ListOrders',variables:{}})});
  const result=await r.json();assert.equal(!result.errors?.length,true,JSON.stringify(result));
  for(const migration of ['order-integrity.sql','order-paid-status.sql','order-capacity-booking.sql','order-actions.sql','payment-edits.sql','order-edits.sql','special-day-capacity.sql','mark-paid-with-balance.sql','historical-order-import.sql'])await pool.query(await readFile(new URL(`../../../migrations/${migration}`,import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/mark-paid-with-balance.sql',import.meta.url),'utf8')); // Repeatable upgrade.
  assert.equal((await pool.query(await readFile(new URL('../../../migrations/verify-mark-paid-with-balance.sql',import.meta.url),'utf8'))).rows[0].ok,true);
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
test('creation deposits are atomic cash receipts with summaries, audit and safe retries',async()=>{
  const addon=randomUUID(),client=randomUUID(),phone='+63'+String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,9)));
  await pool.query("INSERT INTO product(id,name,price_cents,is_active,revision,created_at) VALUES($1,'Deposit test',1000,true,0,now())",[addon]);
  await pool.query("INSERT INTO client(id,phone_number,revision,created_at) VALUES($1,$2,0,now())",[client,phone]);
  for(const cents of [0,250,1000]) {
    const v=input();v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];
    v.clientId=client;v.contactPhoneNumber=phone;v.depositReceivedCents=cents;
    const results=await Promise.all([service.create(actor,v),service.create(actor,v)]);
    assert.deepEqual(results,[{id:v.id},{id:v.id}]);
    // A lost response reconciles to the original receipt, even once pickup has elapsed.
    assert.deepEqual(await new OrderCreationService(pool,()=>new Date('2040-01-01')).create(actor,v),{id:v.id});
    const saved=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[v.id])).rows[0];
    assert.equal(saved.status,'CONFIRMED');assert.equal(saved.final_total_cents,null);
    assert.equal(saved.deposit_required_cents,0);assert.equal(saved.revision,cents?1:0);
    const payments=(await pool.query('SELECT * FROM payment WHERE order_id=$1',[v.id])).rows;
    assert.equal(payments.length,cents?1:0);
    if(cents) {
      assert.equal(payments[0].method,'CASH');assert.equal(payments[0].status,'SUCCEEDED');
      assert.equal(payments[0].amount_cents,cents);assert.ok(payments[0].received_at);
      const event=(await pool.query("SELECT * FROM order_audit_event WHERE order_id=$1 AND action='PAYMENT_RECEIVED'",[v.id])).rows[0];
      assert.equal(event.actor_uid,actor.uid);assert.equal(event.order_revision,1);
      assert.equal(event.changes.after.payment.id,payments[0].id);
    }
    const summary=(await query('FindStaffOrderByNumber',{number:saved.order_number})).staffOrderSummaries[0];
    assert.equal(Number(summary.netPaidCents),cents);assert.equal(Number(summary.balanceCents),1000-cents);
    await assert.rejects(service.create(actor,{...v,depositReceivedCents:cents+1}),{code:'already-exists'});
    await assert.rejects(service.create({...actor,uid:'another'},v),{code:'already-exists'});
  }
  const summary=(await query('GetClientSummary',{id:client})).clientDirectoryEntries[0];
  assert.equal(Number(summary.netPaidCents),1250);assert.equal(Number(summary.orderCount),3);
  const legacy=input();legacy.items[0].productId=addon;legacy.allocations=[];legacy.expectedGroups=[];legacy.depositRequiredCents=300;
  await service.create(actor,legacy);await service.create(actor,legacy);
  assert.equal((await pool.query('SELECT deposit_required_cents FROM customer_order WHERE id=$1',[legacy.id])).rows[0].deposit_required_cents,300);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[legacy.id])).rows[0].n,0);
  const excessive={...legacy,id:randomUUID(),items:[{...legacy.items[0],id:randomUUID()}],depositRequiredCents:0,depositReceivedCents:1001};
  await assert.rejects(service.create(actor,excessive),{code:'invalid-argument'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM customer_order WHERE id=$1',[excessive.id])).rows[0].n,0);
});

test('failure after receipt insertion rolls back order, booking, payment, audit and request',async()=>{
  let calls=0;
  const failing=new OrderCreationService(pool,()=>++calls===1?new Date('2030-01-01'):new Date('2040-01-01'));
  const v=input();v.scheduledFor='2030-06-11T18:00:00.000Z';v.depositReceivedCents=50;
  await assert.rejects(failing.create(actor,v),/PICKUP_EXPIRED/);
  for(const [table,key] of [['customer_order','id'],['order_item','order_id'],['order_capacity_allocation','order_id'],
    ['payment','order_id'],['order_audit_event','order_id'],['order_creation_request','id']])
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${key}=$1`,[v.id])).rows[0].n,0,table);
  await service.create(actor,v);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[v.id])).rows[0].n,1);
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
  const v=input();v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];v.expectedSettingsRevision=(await pool.query("SELECT revision FROM booking_settings WHERE id='default'")).rows[0].revision;await service.create(actor,v);
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
  const v=input();v.scheduledFor='2030-06-08T18:00:00.000Z';v.depositReceivedCents=50;
  const token=`${encode({alg:'none'})}.${encode({sub:actor.uid,aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  const call=async auth=>{
    const response=await fetch('http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/createStaffOrder',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({data:v})});return response.json();
  };
  assert.equal((await call(false)).error.status,'UNAUTHENTICATED');
  const saved=await call(true);assert.equal(saved.result?.id,v.id,JSON.stringify(saved));
  assert.deepEqual(await call(true),saved);
  assert.equal((await pool.query('SELECT amount_cents FROM payment WHERE order_id=$1',[v.id])).rows[0].amount_cents,50);
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
  await pool.query('GRANT SELECT ON product,client,customer_order,order_item,order_capacity_allocation,order_creation_request,booking_settings,capacity_group,special_day_rule TO orders_runtime_test');
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
    // New received deposits use the existing action runtime's additive grants.
    await pool.query('GRANT SELECT ON payment TO orders_runtime_test');
    await pool.query('GRANT INSERT ON payment TO orders_runtime_test');
    await pool.query('GRANT UPDATE(revision,updated_at) ON customer_order TO orders_runtime_test');
    const deposit=input();deposit.scheduledFor='2030-06-12T18:00:00.000Z';deposit.depositReceivedCents=50;
    assert.deepEqual(await runtime.create(actor,deposit),{id:deposit.id});
    assert.deepEqual(await runtime.create(actor,deposit),{id:deposit.id});
    assert.equal((await pool.query('SELECT amount_cents FROM payment WHERE order_id=$1',[deposit.id])).rows[0].amount_cents,50);
    await assert.rejects(restricted.query('UPDATE product SET name=name'),/permission denied/);
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
  const v=input();v.items[0].productId=addon;v.allocations=[];v.expectedGroups=[];v.expectedSettingsRevision=(await pool.query("SELECT revision FROM booking_settings WHERE id='default'")).rows[0].revision;await service.create(actor,v);return v.id;
}
test('cash overpayment, finalization and pickup are audited, atomic and retry safe',async()=>{
  const id=await actionOrder();
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
test('Paid with a balance preserves the agreed total, ledger and pickup eligibility',async()=>{
  const id=await actionOrder();
  await pool.query('UPDATE customer_order SET discount_cents=20,final_total_cents=90 WHERE id=$1',[id]);
  const stale=action(id,0,'PAID');
  await actions.perform(actor,action(id,0,'PAYMENT',50));
  await assert.rejects(actions.perform(actor,stale),/ORDER_CONFLICT/);
  const paid=action(id,1,'PAID');
  await actions.perform(actor,paid);await actions.perform(actor,paid);
  const saved=(await pool.query('SELECT status,revision,discount_cents,final_total_cents FROM customer_order WHERE id=$1',[id])).rows[0];
  assert.deepEqual(saved,{status:'PAID',revision:2,discount_cents:20,final_total_cents:90});
  assert.equal(Number((await query('GetOrder',{id})).financials[0].balanceCents),40);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_audit_event WHERE order_id=$1 AND action='ORDER_MARKED_PAID'",[id])).rows[0].n,1);
  await assert.rejects(actions.perform(actor,action(id,2,'PAYMENT',40)),/ORDER_LOCKED/);
  await actions.perform(actor,action(id,2,'PICKUP'));
  const completed=await query('GetOrder',{id});
  assert.equal(completed.order.status,'COMPLETED');
  assert.equal(Number(completed.financials[0].balanceCents),40);
  assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[id])).rows[0].n,1);
});
test('Mark paid finalizes subtotal less discount at zero balance or with no cash',async()=>{
  for (const paid of [0,80]) {
    const id=await actionOrder();
    await pool.query('UPDATE customer_order SET discount_cents=20 WHERE id=$1',[id]);
    if (paid) await actions.perform(actor,action(id,0,'PAYMENT',paid));
    await actions.perform(actor,action(id,paid ? 1 : 0,'PAID'));
    const result=await query('GetOrder',{id});
    assert.equal(result.order.finalTotalCents,80);
    assert.equal(Number(result.financials[0].balanceCents),80-paid);
    assert.equal((await pool.query('SELECT count(*)::int n FROM payment WHERE order_id=$1',[id])).rows[0].n,paid ? 1 : 0);
  }
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
  await assert.rejects(pool.query("UPDATE customer_order SET status='PAID' WHERE id=$1",[id]),/ORDER_TOTAL_REVIEW/);
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
  const balanceDueID=await actionOrder();
  const paidResponse=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify({data:action(balanceDueID,0,'PAID')})});
  const paidBody=await paidResponse.json();
  assert.equal(paidBody.result?.id,balanceDueID,JSON.stringify(paidBody));
  assert.equal(Number((await query('GetOrder',{id:balanceDueID})).financials[0].balanceCents),100);
  const native=input();native.scheduledFor='2030-07-01T18:00:00.000Z';await service.create(actor,native);const id=native.id;
  await pool.query(`CREATE ROLE action_runtime LOGIN PASSWORD 'test-only';
    GRANT USAGE ON SCHEMA public TO action_runtime;
    GRANT SELECT ON customer_order,payment,refund,order_action_request,order_capacity_allocation,order_item,product,booking_settings,capacity_group TO action_runtime;
    GRANT UPDATE(revision,status,final_total_cents,completed_at,updated_at) ON customer_order TO action_runtime;
    GRANT UPDATE(amount_cents,status) ON payment TO action_runtime;
    GRANT INSERT ON payment,order_action_request,order_audit_event TO action_runtime`);
  const restricted=new pg.Pool({connectionString:'postgresql://action_runtime:test-only@127.0.0.1:15432/restaurant',max:2});
  try {
    const service=new OrderActionService(restricted);
    await service.perform(actor,action(id,0,'PAYMENT',100));
    await service.perform({...actor,token:{admin:true,firebase:{sign_in_provider:'google.com'}}},action(id,1,'PAID'));
    const receipt=(await pool.query('SELECT id FROM payment WHERE order_id=$1',[id])).rows[0].id;
    await service.perform(actor,{...action(id,2,'PAYMENT_EDIT',90),paymentId:receipt});
    await service.perform(actor,action(id,3,'PAYMENT',10));
    await service.perform(actor,action(id,4,'PAID'));
    await service.perform(actor,action(id,5,'PICKUP'));
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
    GRANT SELECT ON booking_settings,capacity_group,product,order_capacity_allocation,customer_order,special_day_rule TO booking_runtime;
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
  await pool.query(await readFile(new URL('../../../migrations/order-edits.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/order-edits.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/special-day-capacity.sql',import.meta.url),'utf8'));
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

const paymentEdit=(id,revision,paymentId,amount)=>({...action(id,revision,'PAYMENT_EDIT',amount),paymentId});
const savedOrder=async id=>(await pool.query('SELECT * FROM customer_order WHERE id=$1',[id])).rows[0];
const savedPayment=async id=>(await pool.query('SELECT * FROM payment WHERE id=$1',[id])).rows[0];
test('cash correction is atomic, capped, idempotent and preserves receipt identity',async()=>{
  const id=await actionOrder(),receipt=action(id,0,'PAYMENT',60);await actions.perform(actor,receipt);
  const original=await savedPayment(receipt.requestId);
  await assert.rejects(actions.perform(actor,paymentEdit(id,1,receipt.requestId,101)),{code:'invalid-argument'});
  await assert.rejects(actions.perform(actor,paymentEdit(id,1,randomUUID(),50)),/ORDER_LOCKED/);
  const other=await actionOrder();await assert.rejects(actions.perform(actor,paymentEdit(other,0,receipt.requestId,50)),/ORDER_LOCKED/);
  const edit=paymentEdit(id,1,receipt.requestId,100);
  await actions.perform(actor,edit);await actions.perform(actor,edit);
  await assert.rejects(actions.perform(actor,{...edit,amountCents:90}),/REQUEST_CONFLICT/);
  await assert.rejects(actions.perform({...actor,uid:'other'},edit),/REQUEST_CONFLICT/);
  assert.equal((await savedOrder(id)).revision,2);
  const corrected=await savedPayment(receipt.requestId);
  assert.equal(corrected.amount_cents,100);assert.equal(+corrected.received_at,+original.received_at);
  assert.equal(+corrected.created_at,+original.created_at);
  const audit=(await pool.query("SELECT * FROM order_audit_event WHERE order_id=$1 AND action='PAYMENT_CORRECTED'",[id])).rows[0];
  assert.equal(audit.actor_uid,actor.uid);assert.equal(audit.changes.before.payment.amountCents,60);
  assert.equal(audit.changes.after.payment.amountCents,100);
  // An unchanged amount is acknowledged once; its identity can still reconcile.
  const same=paymentEdit(id,2,receipt.requestId,100);await actions.perform(actor,same);await actions.perform(actor,same);
  assert.equal((await savedOrder(id)).revision,3);
  const remove=paymentEdit(id,3,receipt.requestId,0);await actions.perform(actor,remove);await actions.perform(actor,remove);
  assert.equal((await savedPayment(receipt.requestId)).status,'VOIDED');
  assert.equal((await savedPayment(receipt.requestId)).amount_cents,100);
  await assert.rejects(actions.perform(actor,paymentEdit(id,4,receipt.requestId,1)),/ORDER_LOCKED/);
  assert.equal(Number((await query('GetOrder',{id})).financials[0].netPaidCents),0);
  await assert.rejects(pool.query('UPDATE payment SET received_at=now() WHERE id=$1',[receipt.requestId]),/PAYMENT_IDENTITY_IMMUTABLE/);
});
test('Paid corrections reopen only when owing, retain final total and serialize with pickup',async()=>{
  const id=await actionOrder(),receipt=action(id,0,'PAYMENT',120);await actions.perform(actor,receipt);
  await actions.perform(actor,action(id,1,'PAID'));
  await assert.rejects(actions.perform(actor,paymentEdit(id,2,receipt.requestId,121)),{code:'invalid-argument'});
  await actions.perform(actor,paymentEdit(id,2,receipt.requestId,110));assert.equal((await savedOrder(id)).status,'PAID');
  const results=await Promise.allSettled([actions.perform(actor,paymentEdit(id,3,receipt.requestId,90)),actions.perform(actor,action(id,3,'PICKUP'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/ORDER_CONFLICT/);
  const order=await savedOrder(id);assert.equal(order.final_total_cents,100);
  if(order.status==='PAID'||order.status==='COMPLETED') {
    await actions.perform(admin,paymentEdit(id,order.revision,receipt.requestId,90));
  } else {assert.equal(order.status,'CONFIRMED');}
});
test('a managed order reopened by a cash correction must use the callable to mark Paid again',async()=>{
  const id=await actionOrder(),receipt=action(id,0,'PAYMENT',100);
  await actions.perform(actor,receipt);
  await actions.perform(actor,action(id,1,'PAID'));
  await actions.perform(actor,paymentEdit(id,2,receipt.requestId,50));
  assert.equal((await savedOrder(id)).status,'CONFIRMED');

  const rejected=await executeConnector('Mutation','MarkOrderPaid',{id,expectedRevision:3});
  const body=await rejected.json();
  assert.match(JSON.stringify(body.errors),/ORDER_FORBIDDEN/);
  assert.equal((await savedOrder(id)).revision,3);

  const paid=action(id,3,'PAID');
  await actions.perform(actor,paid);
  await actions.perform(actor,paid);
  const result=await query('GetOrder',{id});
  assert.equal(result.order.status,'PAID');
  assert.equal(result.order.revision,4);
  assert.equal(result.order.finalTotalCents,100);
  assert.equal(Number(result.financials[0].balanceCents),50);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_action_request WHERE id=$1',[paid.requestId])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_audit_event WHERE order_id=$1 AND order_revision=4 AND action='ORDER_MARKED_PAID'",[id])).rows[0].n,1);
});
test('closed corrections require independent admin and preserve refunds even below their totals',async()=>{
  for(const status of ['COMPLETED','CANCELLED']) {
    const id=await actionOrder(),receipt=action(id,0,'PAYMENT',100);await actions.perform(actor,receipt);
    if(status==='COMPLETED') {await actions.perform(actor,action(id,1,'PAID'));await actions.perform(actor,action(id,2,'PICKUP'));}
    else {await pool.query("UPDATE customer_order SET status='CANCELLED',cancelled_at=now(),cancellation_total_cents=30 WHERE id=$1",[id]);}
    const revision=(await savedOrder(id)).revision,refund=randomUUID();
    await pool.query("INSERT INTO refund(id,payment_id,amount_cents,status,created_at) VALUES($1,$2,80,'SUCCEEDED',now())",[refund,receipt.requestId]);
    await assert.rejects(actions.perform(actor,paymentEdit(id,revision,receipt.requestId,10)),/ORDER_LOCKED/);
    const adminOnly={uid:'admin-only',token:{admin:true,firebase:{sign_in_provider:'google.com'}}};
    const cap=status==='CANCELLED'?110:180;
    await assert.rejects(actions.perform(adminOnly,paymentEdit(id,revision,receipt.requestId,cap+1)),{code:'invalid-argument'});
    await actions.perform(adminOnly,paymentEdit(id,revision,receipt.requestId,10));
    await actions.perform(adminOnly,paymentEdit(id,revision+1,receipt.requestId,0));
    assert.equal((await savedOrder(id)).status,status);
    assert.equal((await pool.query('SELECT amount_cents FROM refund WHERE id=$1',[refund])).rows[0].amount_cents,80);
    const financials=(await query('GetOrder',{id})).financials[0];
    assert.equal(Number(financials.netPaidCents),-80);
    assert.equal(Number(financials.balanceCents),status==='CANCELLED'?110:180);
  }
});
test('corrections roll back ledger, revision and audit when request persistence fails',async()=>{
  const id=await actionOrder(),receipt=action(id,0,'PAYMENT',50);await actions.perform(actor,receipt);
  await pool.query(`CREATE OR REPLACE FUNCTION fail_edit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'edit rollback'; END $$;
    CREATE TRIGGER fail_edit_test BEFORE INSERT ON order_action_request FOR EACH ROW EXECUTE FUNCTION fail_edit_test()`);
  const edit=paymentEdit(id,1,receipt.requestId,25);
  try {await assert.rejects(actions.perform(actor,edit),/edit rollback/);}
  finally {await pool.query('DROP TRIGGER fail_edit_test ON order_action_request; DROP FUNCTION fail_edit_test()');}
  assert.equal((await savedPayment(receipt.requestId)).amount_cents,50);
  assert.equal((await savedOrder(id)).revision,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_audit_event WHERE order_id=$1',[id])).rows[0].n,2);
  await actions.perform(actor,edit);assert.equal((await savedPayment(receipt.requestId)).amount_cents,25);
});

test('competing corrections serialize through the loaded parent revision',async()=>{
  const id=await actionOrder(),receipt=action(id,0,'PAYMENT',60);await actions.perform(actor,receipt);
  const results=await Promise.allSettled([actions.perform(actor,paymentEdit(id,1,receipt.requestId,50)),
    actions.perform(actor,paymentEdit(id,1,receipt.requestId,40))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/ORDER_CONFLICT/);
  assert.equal((await savedOrder(id)).revision,2);
  assert.ok([40,50].includes((await savedPayment(receipt.requestId)).amount_cents));
});

async function currentInput() {
  const v=input();v.expectedSettingsRevision=(await settings()).revision;
  v.expectedGroups[0].expectedRevision=(await pool.query('SELECT revision FROM capacity_group WHERE id=$1',[lechon])).rows[0].revision;
  v.items[0].expectedRevision=(await pool.query('SELECT revision FROM product WHERE id=$1',[product])).rows[0].revision;
  return v;
}
async function editInput(id, patch={}) {
  const o=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[id])).rows[0];
  const items=(await pool.query('SELECT * FROM order_item WHERE order_id=$1 ORDER BY id',[id])).rows;
  const a=(await pool.query('SELECT * FROM order_capacity_allocation WHERE order_id=$1 ORDER BY group_id,block_minute',[id])).rows;
  return {action:'EDIT',requestId:randomUUID(),id,expectedRevision:o.revision,
    items:items.map(i=>({id:i.id,productId:i.product_id,quantity:i.quantity})),clientId:o.client_id,contactPhoneNumber:o.contact_phone_number,
    scheduledFor:o.scheduled_for.toISOString(),expectedSettingsRevision:(await settings()).revision,
    expectedGroups:await Promise.all([...new Set(items.map(i=>i.capacity_group_id).filter(Boolean))].map(async id=>({id,expectedRevision:(await pool.query('SELECT revision FROM capacity_group WHERE id=$1',[id])).rows[0].revision}))),
    allocations:a.map(v=>({groupId:v.group_id,blockMinute:v.block_minute,quantity:v.quantity})),notes:o.notes,...patch};
}
test('edit preserves snapshots, reconciles before time checks, changes Paid and rolls back stale writes',async()=>{
  const v=await currentInput();v.scheduledFor='2030-10-01T18:00:00Z';await service.create(actor,v);
  const actions=new OrderActionService(pool), edits=new OrderEditService(pool,()=>new Date('2029-01-01'));
  await actions.perform(actor,action(v.id,0,'PAYMENT',100));await actions.perform(actor,action(v.id,1,'PAID'));
  await pool.query('UPDATE product SET price_cents=250,revision=revision+1 WHERE id=$1',[product]);
  const e=await editInput(v.id);e.items[0].quantity=2;e.allocations[0].quantity=2;
  await edits.edit(actor,e);await edits.edit(actor,e);
  const saved=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[v.id])).rows[0];
  assert.equal(saved.status,'CONFIRMED');assert.equal(saved.final_total_cents,200);assert.equal(saved.subtotal_cents,200);
  assert.equal((await pool.query('SELECT unit_price_cents FROM order_item WHERE order_id=$1',[v.id])).rows[0].unit_price_cents,100);
  await assert.rejects(edits.edit(actor,{...e,requestId:randomUUID()}),{code:'aborted'});
  await assert.rejects(edits.edit(actor,{...e,notes:'different'}),{code:'already-exists'});
  assert.deepEqual(await new OrderEditService(pool,()=>new Date('2040-01-01')).edit(actor,e),{id:v.id});
  const notes=await editInput(v.id,{notes:'Past schedule unchanged'});
  await new OrderEditService(pool,()=>new Date('2040-01-01')).edit(actor,notes);
  const past=await editInput(v.id,{scheduledFor:'2030-10-02T18:00:00Z'});
  await assert.rejects(new OrderEditService(pool,()=>new Date('2040-01-01')).edit(actor,past),{code:'failed-precondition'});
  await assert.rejects(pool.query('UPDATE order_item SET quantity=3 WHERE order_id=$1',[v.id]),/ALLOCATION_AWARE_EDIT_REQUIRED/);
  await assert.rejects(pool.query('DELETE FROM order_capacity_allocation WHERE order_id=$1',[v.id]),/ALLOCATION_AWARE_EDIT_REQUIRED/);
  const changed=await editInput(v.id);changed.allocations[0].quantity=1;
  await assert.rejects(edits.edit(actor,changed),{code:'invalid-argument'});
  assert.equal((await pool.query('SELECT revision FROM customer_order WHERE id=$1',[v.id])).rows[0].revision,notes.expectedRevision+1);
});
test('staff cancellation splits cash refunds, records retained charge, releases capacity and retries once',async()=>{
  const v=await currentInput();v.items[0].expectedRevision=(await pool.query('SELECT revision FROM product WHERE id=$1',[product])).rows[0].revision;
  v.scheduledFor='2030-11-01T18:00:00Z';await service.create(actor,v);
  const actions=new OrderActionService(pool);
  await actions.perform(actor,action(v.id,0,'PAYMENT',100));await actions.perform(actor,action(v.id,1,'PAYMENT',200));
  const receipts=(await pool.query('SELECT * FROM payment WHERE order_id=$1 ORDER BY received_at,id',[v.id])).rows;
  const c={...action(v.id,2,'CANCEL'),refundAmountCents:150,reason:'Client changed date'};
  await Promise.all([actions.perform(actor,c),actions.perform(actor,c)]);
  const saved=(await pool.query('SELECT * FROM customer_order WHERE id=$1',[v.id])).rows[0];
  assert.equal(saved.status,'CANCELLED');assert.equal(saved.cancellation_total_cents,150);assert.equal(saved.revision,3);
  const refunds=(await pool.query('SELECT * FROM refund WHERE payment_id=ANY($1::uuid[])',[receipts.map(r=>r.id)])).rows;
  assert.equal(refunds.reduce((n,r)=>n+r.amount_cents,0),150);
  assert.equal(refunds.find(r=>r.payment_id===receipts[0].id).amount_cents,Math.min(150,receipts[0].amount_cents));
  const audit=(await pool.query("SELECT changes FROM order_audit_event WHERE order_id=$1 AND action='ORDER_CANCELLED'",[v.id])).rows[0].changes;
  assert.equal(audit.after.reason,c.reason);assert.equal(audit.after.refunds.length,refunds.length);
  let offset=0,booked;do {const page=await new BookingAvailabilityService(pool).get(actor,{day:'2030-11-01',offset});booked??=page.blocks.find(b=>b.groupId===lechon&&b.blockMinute===780)?.booked;offset=page.nextOffset;}while(offset!==null);assert.equal(Number(booked),0);
  await assert.rejects(actions.perform(actor,{...c,requestId:randomUUID(),expectedRevision:3}),{code:'failed-precondition'});
});
test('unpaid cancellation, excessive refund rejection and restricted edit/cancel grants',async()=>{
  const v=await currentInput();v.items[0].expectedRevision=(await pool.query('SELECT revision FROM product WHERE id=$1',[product])).rows[0].revision;
  v.scheduledFor='2030-12-01T18:00:00Z';await service.create(actor,v);
  await pool.query(`CREATE ROLE edit_runtime LOGIN PASSWORD 'test-only';
    GRANT USAGE ON SCHEMA public TO edit_runtime;
    GRANT SELECT ON customer_order,order_item,product,client,payment,refund,order_action_request,order_capacity_allocation,booking_settings,capacity_group,special_day_rule TO edit_runtime;
    GRANT UPDATE(revision,status,cancelled_at,cancellation_total_cents,updated_at) ON customer_order TO edit_runtime;
    GRANT INSERT ON refund,order_audit_event,order_action_request TO edit_runtime;
    GRANT UPDATE(amount_cents,status) ON payment TO edit_runtime;
    GRANT EXECUTE ON FUNCTION public.apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb),public.lock_order_creation_sources(uuid[],uuid) TO edit_runtime`);
  const restricted=new pg.Pool({connectionString:'postgresql://edit_runtime:test-only@127.0.0.1:15432/restaurant',max:2});
  try {
    await assert.rejects(restricted.query('INSERT INTO native_order_edit_context VALUES(pg_backend_pid(),txid_current(),$1)',[v.id]),/permission denied/);
    await assert.rejects(restricted.query('UPDATE order_item SET quantity=quantity WHERE order_id=$1',[v.id]),/permission denied/);
    const e=await editInput(v.id,{notes:'Restricted runtime edit'});
    await new OrderEditService(restricted,()=>new Date('2029-01-01')).edit(actor,e);
    const actions=new OrderActionService(restricted),c={...action(v.id,1,'CANCEL'),refundAmountCents:1};
    await assert.rejects(actions.perform(actor,c),{code:'invalid-argument'});
    assert.equal((await pool.query('SELECT status FROM customer_order WHERE id=$1',[v.id])).rows[0].status,'CONFIRMED');
    await actions.perform(actor,{...c,refundAmountCents:0});
    assert.equal((await pool.query('SELECT cancellation_total_cents FROM customer_order WHERE id=$1',[v.id])).rows[0].cancellation_total_cents,0);
  } finally {await restricted.end();}
});

test('edit migration removes inherited SQL Connect private context and routine grants',async()=>{
  await pool.query(`CREATE ROLE firebasereader_restaurant_public;
    CREATE ROLE firebasewriter_restaurant_public;
    GRANT SELECT ON native_order_edit_context TO firebasereader_restaurant_public;
    GRANT ALL ON native_order_edit_context TO firebasewriter_restaurant_public;
    GRANT EXECUTE ON FUNCTION apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)
      TO firebasereader_restaurant_public,firebasewriter_restaurant_public`);
  await pool.query(await readFile(new URL('../../../migrations/order-edits.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/special-day-capacity.sql',import.meta.url),'utf8'));
  for(const role of ['firebasereader_restaurant_public','firebasewriter_restaurant_public']) {
    const result=(await pool.query(`SELECT
      has_table_privilege($1,'native_order_edit_context','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') context,
      has_function_privilege($1,'apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)','EXECUTE') edit`,[role])).rows[0];
    assert.deepEqual(result,{context:false,edit:false});
  }
  // Repeatable maintenance must retain the separately granted Orders access.
  assert.equal((await pool.query("SELECT has_function_privilege('edit_runtime','apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)','EXECUTE') allowed")).rows[0].allowed,true);
});

async function isolatedEditOrder(day='2031-01-01',quantity=1,limit=3) {
  const group=randomUUID(),p=randomUUID();
  await configuration.change(admin,{action:'CREATE_GROUP',id:group,code:'EDIT_'+group.replaceAll('-','').slice(0,8).toUpperCase(),name:'Edit fixture',capacityPerBlock:limit});
  await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'Edit item',100,true,$2,0,now())",[p,group]);
  const v={id:randomUUID(),items:[{id:randomUUID(),productId:p,expectedRevision:0,quantity}],clientId:null,contactPhoneNumber:null,
    scheduledFor:day+'T18:00:00Z',expectedSettingsRevision:(await settings()).revision,expectedGroups:[{id:group,expectedRevision:0}],
    allocations:[{groupId:group,blockMinute:780,quantity}],depositRequiredCents:0,notes:null};
  await new OrderCreationService(pool,()=>new Date('2019-01-01')).create(actor,v);
  return {v,group,p};
}
test('edits keep hidden/archived snapshots and allow decreases above a lowered historical limit',async()=>{
  const {v,group,p}=await isolatedEditOrder('2020-01-01',2);
  await pool.query('UPDATE product SET is_active=false,capacity_group_id=null,revision=revision+1 WHERE id=$1',[p]);
  await updateGroup(group,{capacityPerBlock:1,archived:true});
  const e=await editInput(v.id,{notes:'Keep historical booking'});
  const edits=new OrderEditService(pool,()=>new Date('2019-01-01'));
  await edits.edit(actor,e);
  const reduce=await editInput(v.id);reduce.items[0].quantity=1;reduce.allocations[0].quantity=1;
  await edits.edit(actor,reduce);
  const saved=(await pool.query('SELECT * FROM order_item WHERE order_id=$1',[v.id])).rows[0];
  assert.equal(saved.capacity_group_id,group);assert.equal(saved.product_name,'Edit item');assert.equal(saved.unit_price_cents,100);
  const increase=await editInput(v.id);increase.items[0].quantity=2;increase.allocations[0].quantity=2;
  await assert.rejects(edits.edit(actor,increase),{code:'resource-exhausted'});
});
test('competing edits reserve capacity once and added products use current snapshots',async()=>{
  const a=await isolatedEditOrder('2031-02-01',1,3);
  const b={...a.v,id:randomUUID(),items:[{...a.v.items[0],id:randomUUID()}]};
  await service.create(actor,b);
  const edits=new OrderEditService(pool,()=>new Date('2029-01-01'));
  const x=await editInput(a.v.id),y=await editInput(b.id);
  for(const e of [x,y]) {e.items[0].quantity=2;e.allocations[0].quantity=2;}
  const results=await Promise.allSettled([edits.edit(actor,x),edits.edit(actor,y)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'resource-exhausted');
  const extra=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,revision,created_at) VALUES($1,'Fresh price',325,true,2,now())",[extra]);
  const edit=await editInput(a.v.id);edit.items.push({id:randomUUID(),productId:extra,quantity:1,expectedRevision:1});
  await assert.rejects(edits.edit(actor,edit),{code:'failed-precondition'});
  edit.items[1].expectedRevision=2;await edits.edit(actor,edit);
  assert.equal((await pool.query('SELECT unit_price_cents FROM order_item WHERE order_id=$1 AND product_id=$2',[a.v.id,extra])).rows[0].unit_price_cents,325);
});
test('cancel accounts for prior refunds, rejects negative net and rolls back all effects on persistence failure',async()=>{
  const {v}=await isolatedEditOrder('2031-03-01');const actions=new OrderActionService(pool);
  const receipt=action(v.id,0,'PAYMENT',200);await actions.perform(actor,receipt);
  await pool.query("INSERT INTO refund(id,payment_id,amount_cents,status,created_at) VALUES($1,$2,50,'SUCCEEDED',now())",[randomUUID(),receipt.requestId]);
  const c={...action(v.id,1,'CANCEL'),refundAmountCents:150};
  await pool.query(`CREATE FUNCTION fail_cancel_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cancel rollback'; END $$;
    CREATE TRIGGER fail_cancel_test BEFORE INSERT ON order_action_request FOR EACH ROW EXECUTE FUNCTION fail_cancel_test()`);
  try {await assert.rejects(actions.perform(actor,c),/cancel rollback/);}
  finally {await pool.query('DROP TRIGGER fail_cancel_test ON order_action_request; DROP FUNCTION fail_cancel_test()');}
  assert.equal((await savedOrder(v.id)).status,'CONFIRMED');assert.equal((await savedOrder(v.id)).revision,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM refund WHERE payment_id=$1',[receipt.requestId])).rows[0].n,1);
  await actions.perform(actor,c);assert.equal((await savedOrder(v.id)).cancellation_total_cents,0);
  const negative=await isolatedEditOrder('2031-03-02');const r=action(negative.v.id,0,'PAYMENT',100);
  await actions.perform(actor,r);
  await pool.query("INSERT INTO refund(id,payment_id,amount_cents,status,created_at) VALUES($1,$2,100,'SUCCEEDED',now())",[randomUUID(),r.requestId]);
  await actions.perform(actor,paymentEdit(negative.v.id,1,r.requestId,50));
  await assert.rejects(actions.perform(actor,{...action(negative.v.id,2,'CANCEL'),refundAmountCents:0}),{code:'invalid-argument'});
  assert.equal((await savedOrder(negative.v.id)).status,'CONFIRMED');
});
test('edit links current client phone, keeps saved group names, and can unlink without touching contacts',async()=>{
  const {v,group,p}=await isolatedEditOrder('2031-04-01');
  const client=randomUUID(),phone='+63'+String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,9)));
  await pool.query("INSERT INTO client(id,phone_number,name,revision,created_at) VALUES($1,$2,'Edit client',0,now())",[client,phone]);
  const extra=randomUUID();await pool.query("INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at) VALUES($1,'New group product',200,true,$2,0,now())",[extra,group]);
  await updateGroup(group,{name:'Renamed group'});
  const edits=new OrderEditService(pool,()=>new Date('2029-01-01'));
  const e=await editInput(v.id,{clientId:client,contactPhoneNumber:phone});
  e.items.push({id:randomUUID(),productId:extra,expectedRevision:0,quantity:1});e.allocations[0].quantity=2;
  await edits.edit(actor,e);
  const lines=(await pool.query('SELECT * FROM order_item WHERE order_id=$1',[v.id])).rows;
  assert.equal(lines.find(i=>i.product_id===p).capacity_group_name_snapshot,'Edit fixture');
  assert.equal(lines.find(i=>i.product_id===extra).capacity_group_name_snapshot,'Edit fixture');
  const unlink=await editInput(v.id,{clientId:null,contactPhoneNumber:null});await edits.edit(actor,unlink);
  assert.equal((await savedOrder(v.id)).client_id,null);assert.equal((await savedOrder(v.id)).contact_phone_number,null);
  assert.equal((await pool.query('SELECT phone_number FROM client WHERE id=$1',[client])).rows[0].phone_number,phone);
});

async function availabilityForGroup(day,groupId) {
  let offset=0;
  do {
    const page=await availabilityService.get(actor,{day,offset});
    const block=page.blocks.find(row=>row.groupId===groupId&&row.blockMinute===780);
    if(block) return {block,revision:page.settings.revision};
    offset=page.nextOffset;
  } while(offset!==null);
  assert.fail(`Missing availability for group ${groupId}`);
}

test('annual rules use committed precedence and preserve occupancy under a zero limit',async()=>{
  const day='2032-02-29';
  const {v,group}=await isolatedEditOrder(day,3,4);
  const fallback={action:'CREATE_SPECIAL_DAY',id:randomUUID(),groupId:group,capacityPerBlock:2,dayKeys:[229]};
  await assert.rejects(configuration.change(actor,fallback),{code:'permission-denied'});
  await assert.rejects(query('ListSpecialDayRules'),/@auth|permission/i);
  await assert.rejects(configuration.change(admin,{...fallback,dayKeys:[230]}),{code:'invalid-argument'});
  const first=await configuration.change(admin,fallback);
  const closed={...fallback,id:randomUUID(),capacityPerBlock:0};
  const newest=await configuration.change(admin,closed);
  assert.ok(newest.rule.savedRevision>first.rule.savedRevision);
  assert.deepEqual(await configuration.change(admin,fallback),first);
  assert.equal((await settings()).revision,newest.rule.savedRevision);
  const listed=await query('ListSpecialDayRules',{}, {staff:true,admin:true});
  assert.equal(listed.specialDayRules.filter(r=>r.groupId.replaceAll('-','')===group.replaceAll('-','')).length,2);

  const block=async (date=day)=>(await availabilityForGroup(date,group)).block;
  const closedBlock=await block();
  assert.deepEqual([closedBlock.capacity,closedBlock.booked,closedBlock.remaining],[0,'3','-3']);
  assert.equal((await block('2031-02-28')).capacity,4);
  assert.equal((await block('2028-02-29')).capacity,0);
  const copy={...v,id:randomUUID(),items:[{...v.items[0],id:randomUUID()}]};
  await assert.rejects(service.create(actor,copy),/BOOKING_CONFIGURATION_CHANGED/);
  copy.expectedSettingsRevision=(await settings()).revision;
  await assert.rejects(service.create(actor,copy),/GROUP_CAPACITY/);

  const editor=new OrderEditService(pool,()=>new Date('2030-01-01'));
  await editor.edit(actor,await editInput(v.id,{notes:'Keep the booking'}));
  const reduced=await editInput(v.id);
  reduced.items[0].quantity=2;
  reduced.allocations[0].quantity=2;
  await editor.edit(actor,reduced);
  const increase=await editInput(v.id);
  increase.items[0].quantity=3;
  increase.allocations[0].quantity=3;
  await assert.rejects(editor.edit(actor,increase),/GROUP_CAPACITY/);
  const move=await editInput(v.id);
  move.allocations[0].blockMinute=660;
  await assert.rejects(editor.edit(actor,move),/GROUP_CAPACITY/);

  await updateGroup(group,{capacityPerBlock:1}); // The annual rule covers the upcoming booking.
  const update={action:'UPDATE_SPECIAL_DAY',id:closed.id,expectedRevision:0,capacityPerBlock:1,dayKeys:[229]};
  await configuration.change(admin,update);
  await assert.rejects(configuration.change(admin,update),/BOOKING_CONFIGURATION_CONFLICT/);
  await cancel(v.id);
  await assert.rejects(pool.query("UPDATE customer_order SET status='CONFIRMED',cancelled_at=null WHERE id=$1",[v.id]),/GROUP_CAPACITY/);
  await assert.rejects(configuration.change(admin,{action:'REMOVE_SPECIAL_DAY',id:closed.id,expectedRevision:0}),/BOOKING_CONFIGURATION_CONFLICT/);
  await configuration.change(admin,{action:'REMOVE_SPECIAL_DAY',id:closed.id,expectedRevision:1});
  assert.equal((await block()).capacity,2);
  await configuration.change(admin,{action:'REMOVE_SPECIAL_DAY',id:fallback.id,expectedRevision:0});
  assert.equal((await block()).capacity,1);
});

test('a rule racing order creation commits atomically with its configuration revision',async()=>{
  const day='2032-12-24';
  const {v,group}=await isolatedEditOrder(day,1,4);
  const next={...v,id:randomUUID(),items:[{...v.items[0],id:randomUUID()}]};
  const rule={action:'CREATE_SPECIAL_DAY',id:randomUUID(),groupId:group,capacityPerBlock:0,dayKeys:[1224]};
  const [change,booking]=await Promise.allSettled([configuration.change(admin,rule),service.create(actor,next)]);
  assert.equal(change.status,'fulfilled');
  if(booking.status==='rejected') assert.match(booking.reason.message,/BOOKING_CONFIGURATION_CHANGED/);
  const {block,revision}=await availabilityForGroup(day,group);
  assert.equal(revision,change.value.rule.savedRevision);
  assert.equal(block.capacity,0);
  assert.equal(block.booked,booking.status==='fulfilled'?'2':'1');
});

const historicalAdmin = {uid: 'historical-admin', token: {admin: true, firebase: {sign_in_provider: 'google.com'}}};
const historicalPickup = '2025-11-01T16:37:00.000Z';
function historicalInput(productId, expectedRevision = 0) {
  return {id: randomUUID(), items: [{id: randomUUID(), productId, quantity: 1, expectedRevision}],
    scheduledFor: historicalPickup, payments: [{amountCents: 10000}, {amountCents: 20000}]};
}

test('historical import preserves receipts, audit dates and balance using restricted runtime grants', async () => {
  const productId = randomUUID(), clientId = randomUUID();
  await pool.query(`INSERT INTO product(id,name,price_cents,is_active,capacity_group_id,revision,created_at)
    VALUES($1,'Historical 70LB',32000,false,$2,2,now())`, [productId, lechon]);
  await pool.query("INSERT INTO client(id,phone_number,revision,created_at) VALUES($1,'+14165550191',0,now())", [clientId]);
  const v = {...historicalInput(productId, 2), clientId, contactPhoneNumber: '4165550191',
    createdAt: '2025-10-22T14:20:00.000Z'};
  v.payments[0].receivedAt = '2025-10-22T15:10:00.000Z';
  await pool.query(`CREATE ROLE historical_runtime NOLOGIN;
    GRANT USAGE ON SCHEMA public TO historical_runtime;
    GRANT SELECT ON product,client,customer_order,order_item,order_capacity_allocation,order_creation_request TO historical_runtime;
    GRANT INSERT ON customer_order,order_item,payment,order_creation_request,order_audit_event TO historical_runtime;
    GRANT UPDATE(revision,status,final_total_cents,completed_at) ON customer_order TO historical_runtime;
    GRANT EXECUTE ON FUNCTION public.lock_order_creation_sources(uuid[],uuid) TO historical_runtime`);
  const restricted = new pg.Pool({connectionString: 'postgresql://postgres:test-only@127.0.0.1:15432/restaurant',
    max: 2, options: '-c role=historical_runtime'});
  try {
    const importer = new HistoricalOrderImportService(restricted);
    assert.deepEqual(await Promise.all([importer.importOrder(historicalAdmin, v), importer.importOrder(historicalAdmin, v)]),
      [{id: v.id}, {id: v.id}]);
    await pool.query('UPDATE product SET price_cents=33000,revision=revision+1 WHERE id=$1', [productId]);
    assert.deepEqual(await importer.importOrder(historicalAdmin, v), {id: v.id});
    await assert.rejects(importer.importOrder({...historicalAdmin, uid: 'other-admin'}, v), {code: 'already-exists'});
    await assert.rejects(importer.importOrder(historicalAdmin, {...v, notes: 'Different'}), {code: 'already-exists'});
    await assert.rejects(service.create(actor, {...input(), id: v.id}), {code: 'already-exists'});

    const {order, financials: [summary]} = await query('GetOrder', {id: v.id});
    assert.equal(order.status, 'COMPLETED');
    assert.equal(order.revision, 4);
    assert.equal(order.finalTotalCents, 32000);
    assert.equal(order.subtotalCents, 32000);
    assert.equal(Date.parse(order.createdAt), Date.parse(v.createdAt));
    assert.equal(Date.parse(order.scheduledFor), Date.parse(historicalPickup));
    assert.equal(Date.parse(order.completedAt), Date.parse(historicalPickup));
    assert.equal(Number(summary.netPaidCents), 30000);
    assert.equal(Number(summary.balanceCents), 2000);
    const {orderItems: [item]} = await query('ListOrderItems', {id: v.id});
    assert.equal(item.unitPriceCents, 32000);
    assert.equal(item.capacityGroupId, null);
    assert.deepEqual((await query('ListOrderCapacityAllocations', {id: v.id})).orderCapacityAllocations, []);
    const {payments} = await query('ListOrderPayments', {id: v.id});
    assert.deepEqual(payments.map(payment => [payment.method, payment.status, payment.amountCents, Date.parse(payment.receivedAt)]),
      [['CASH', 'SUCCEEDED', 10000, Date.parse(v.payments[0].receivedAt)], ['CASH', 'SUCCEEDED', 20000, Date.parse(historicalPickup)]]);
    const {orderAuditEvents: events} = await query('ListOrderAuditEvents', {id: v.id});
    assert.deepEqual(events.map(event => event.action),
      ['ORDER_CREATED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED', 'ORDER_MARKED_PAID', 'ORDER_COMPLETED']);
    assert.ok(events.every((event, revision) => event.actorUid === historicalAdmin.uid && event.orderRevision === revision));
    assert.ok(Date.parse(events[0].changes.historicalImport.importedAt) > Date.parse(historicalPickup));
    assert.deepEqual(events.map(event => Date.parse(event.occurredAt)),
      [v.createdAt, v.payments[0].receivedAt, historicalPickup, historicalPickup, historicalPickup].map(Date.parse));
    assert.equal((await query('GetClientSummary', {id: clientId})).clientDirectoryEntries[0].orderCount.toString(), '1');
    await assert.rejects(restricted.query("UPDATE customer_order SET status='CONFIRMED',completed_at=NULL WHERE id=$1", [v.id]),
      /HISTORICAL_ORDER_CLOSED/);
    const reopen = await executeConnector('Mutation', 'ReopenOrder', {id: v.id, expectedRevision: order.revision}, {admin: true});
    assert.match(JSON.stringify(await reopen.json()), /ORDER_CONFLICT/);
    const {rows: [{id: paymentId}]} = await pool.query('SELECT id FROM payment WHERE order_id=$1 AND amount_cents=10000', [v.id]);
    await actions.perform(historicalAdmin, {...action(v.id, 4, 'PAYMENT_EDIT', 9000), paymentId});
    const corrected = await query('GetOrder', {id: v.id});
    assert.equal(corrected.order.status, 'COMPLETED');
    assert.equal(Number(corrected.financials[0].balanceCents), 3000);
  } finally {
    await restricted.end();
    await pool.query('DROP OWNED BY historical_runtime; DROP ROLE historical_runtime');
  }
});

test('historical callable permits Google Admin only and defaults omitted event timestamps to pickup', async () => {
  const v = historicalInput(product, (await pool.query('SELECT revision FROM product WHERE id=$1', [product])).rows[0].revision);
  const call = async claims => {
    const headers = {'Content-Type': 'application/json'};
    if (claims) {
      const token = `${encode({alg:'none'})}.${encode({sub:historicalAdmin.uid,aud:'demo-mtl',
        iss:'https://securetoken.google.com/demo-mtl', firebase:{sign_in_provider:'google.com'},
        iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})}.`;
      headers.Authorization = `Bearer ${token}`;
    }
    const url = 'http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/importHistoricalOrder';
    const response = await fetch(url, {method: 'POST', headers, body: JSON.stringify({data: v})});
    return response.json();
  };
  assert.equal((await call()).error.status, 'UNAUTHENTICATED');
  assert.equal((await call({staff: true})).error.status, 'PERMISSION_DENIED');
  assert.equal((await call({admin: 'true'})).error.status, 'PERMISSION_DENIED');
  assert.equal((await call({admin: true, firebase: {sign_in_provider: 'password'}})).error.status, 'PERMISSION_DENIED');
  const saved = await call({admin: true});
  assert.deepEqual(saved, {result: {id: v.id}});
  assert.deepEqual(await call({admin: true}), saved);
  assert.equal(Date.parse((await query('GetOrder', {id: v.id})).order.createdAt), Date.parse(historicalPickup));
  assert.ok((await query('ListOrderPayments', {id: v.id})).payments.every(payment =>
    Date.parse(payment.receivedAt) === Date.parse(historicalPickup)));
});

test('historical import rejects stale or missing products and rolls back failure after financial writes', async () => {
  const importer = new HistoricalOrderImportService(pool);
  const v = historicalInput(product, (await pool.query('SELECT revision FROM product WHERE id=$1', [product])).rows[0].revision);
  await assert.rejects(importer.importOrder(historicalAdmin, {...v, scheduledFor: '9999-01-01T00:00:00Z'}), /HISTORICAL_PICKUP_REQUIRED/);
  await assert.rejects(importer.importOrder(historicalAdmin, {...v, items: [...v.items,
    {id: randomUUID(), productId: randomUUID(), quantity: 1, expectedRevision: 0}]}), /PRODUCT_UNAVAILABLE/);
  await assert.rejects(importer.importOrder(historicalAdmin, {...v, items: [{...v.items[0], expectedRevision: 99}]}), /CATALOG_CHANGED/);
  const liveOrder = (await pool.query('SELECT id FROM order_creation_request WHERE id<>$1 LIMIT 1', [v.id])).rows[0].id;
  await assert.rejects(importer.importOrder(historicalAdmin, {...v, id: liveOrder}), {code: 'already-exists'});
  await pool.query(`CREATE FUNCTION public.reject_test_historical_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test import failure'; END $$;
    CREATE TRIGGER reject_test_historical_request BEFORE INSERT ON order_creation_request
    FOR EACH ROW WHEN (NEW.id = '${v.id}') EXECUTE FUNCTION public.reject_test_historical_request()`);
  try {
    await assert.rejects(importer.importOrder(historicalAdmin, v), /test import failure/);
    for (const [table, key] of [['customer_order', 'id'], ['order_item', 'order_id'], ['payment', 'order_id'],
      ['order_audit_event', 'order_id'], ['order_capacity_allocation', 'order_id'], ['order_creation_request', 'id']]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key}=$1`, [v.id])).rows[0].n, 0, table);
    }
  } finally {
    await pool.query('DROP TRIGGER reject_test_historical_request ON order_creation_request; DROP FUNCTION public.reject_test_historical_request()');
  }
  assert.deepEqual(await importer.importOrder(historicalAdmin, v), {id: v.id});
});
