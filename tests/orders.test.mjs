import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Fixed local demo endpoint: these tests cannot target a cloud project.
const service = 'http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant';
const staff = {sub:'order-staff', staff:true, firebase:{sign_in_provider:'google.com'}};
const admin = {sub:'order-admin', admin:true, firebase:{sign_in_provider:'google.com'}};
const catalogAdmin = {...admin, staff:true};
// SQL Connect returns UUIDs without hyphens. Both input forms are accepted.
const uuid = () => randomUUID().replaceAll('-', '');
function token(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg:'none',typ:'JWT'})}.${encode({aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})}.`;
}
async function call(operationName, variables={}, claims=staff) {
  const headers = {'Content-Type':'application/json'};
  if (claims) headers['x-firebase-auth-token'] = token(claims);
  const kind = /^(Get|List)/.test(operationName) ? 'Query' : 'Mutation';
  const response = await fetch(`${service}/connectors/staff-admin:execute${kind}`, {
    method:'POST', headers, body:JSON.stringify({operationName,variables})
  });
  const body = await response.json();
  return {ok:response.ok && !body.errors?.length,body};
}
async function ok(name, vars, claims=staff) {
  const result = await call(name,vars,claims);
  assert.equal(result.ok,true,`${name}: ${JSON.stringify(result.body)}`);
  return result.body.data;
}
async function denied(name,vars,claims=staff,match) {
  const result = await call(name,vars,claims);
  assert.equal(result.ok,false,`${name}: ${JSON.stringify(result.body)}`);
  if (match) assert.match(JSON.stringify(result.body),match);
}
async function product(priceCents=1000) {
  const id = uuid();
  await ok('CreateProduct',{id,name:'Order test product',chineseName:'測試',priceCents,isActive:true,isLechon:false},catalogAdmin);
  return id;
}
async function create(extra={},claims=staff) {
  const vars = {id:uuid(),itemId:uuid(),productId:await product(),quantity:2,...extra};
  await ok('CreateOrder',vars,claims);
  return vars;
}
async function get(id) { return ok('GetOrder',{id}); }
async function events(id) { return (await ok('ListOrderAuditEvents',{id})).orderAuditEvents; }

test('walk-in order has server number, exact totals and automatic trusted audit',async()=>{
  const value = await create();
  const {order,financials} = await get(value.id);
  assert.match(order.orderNumber,/^[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(order.clientId,null);
  assert.equal(order.contactPhoneNumber,null);
  assert.equal(order.status,'CONFIRMED');
  assert.equal(order.fulfillmentType,'PICKUP');
  assert.equal(order.subtotalCents,2000);
  assert.equal(order.itemCount,1);
  assert.equal(order.finalTotalCents,null);
  assert.equal(Number(financials[0].balanceCents),2000);
  assert.equal(financials[0].isEstimate,true);
  const history = await events(value.id);
  assert.equal(history.length,1);
  assert.equal(history[0].actorUid,staff.sub);
  assert.equal(history[0].action,'ORDER_CREATED');
  assert.equal(history[0].orderRevision,0);
  assert.equal(history[0].changes.before,null);
  assert.equal(history[0].changes.after.order.subtotalCents,2000);
  assert.equal(history[0].changes.after.item.productId,value.productId);
  assert.ok(history[0].occurredAt);
  const byCode = await ok('GetOrderByNumber',{orderNumber:order.orderNumber.toLowerCase()});
  assert.equal(byCode.orders[0].id,value.id);
});

test('contact snapshot normalizes and phone search returns multiple orders',async()=>{
  const clientId=uuid();
  await ok('CreateClient',{id:clientId,phoneNumber:'9055550131'});
  const a=await create({clientId});
  const b=await create({contactPhoneNumber:'9055550131'});
  assert.equal((await get(a.id)).order.contactPhoneNumber,'+19055550131');
  await ok('UpdateClient',{id:clientId,phoneNumber:'9055550132',expectedRevision:0});
  assert.equal((await get(a.id)).order.contactPhoneNumber,'+19055550131');
  for(const phoneNumber of ['9055550131','+19055550131']) {
    const results=await ok('GetOrdersByPhoneNumber',{phoneNumber});
    assert.deepEqual(new Set(results.orders.map(o=>o.id)),new Set([a.id,b.id]));
  }
  await ok('AssignOrderClient',{id:b.id,expectedRevision:0,clientId});
  assert.equal((await get(b.id)).order.contactPhoneNumber,'+19055550131');
  await ok('UpdateOrderContact',{id:b.id,expectedRevision:1,contactPhoneNumber:null,notes:'assigned'});
  assert.equal((await get(b.id)).order.contactPhoneNumber,null);
  assert.equal((await get(b.id)).order.clientId,clientId);
});

test('scheduled pickup is optional and timestamp edits are audited without changing creation time',async()=>{
  const scheduledFor='2027-01-03T18:00:00Z';
  const value=await create({scheduledFor},admin);
  const original=(await get(value.id)).order;
  assert.equal(Date.parse(original.scheduledFor),Date.parse(scheduledFor));
  await ok('UpdateOrderSchedule',{id:value.id,expectedRevision:0,scheduledFor:'2027-01-04T19:00:00Z'});
  await ok('UpdateOrderSchedule',{id:value.id,expectedRevision:1,scheduledFor:null});
  const current=(await get(value.id)).order;
  assert.equal(current.scheduledFor,null);
  assert.equal(current.createdAt,original.createdAt);
  const history=await events(value.id);
  assert.equal(Date.parse(history[1].changes.before.order.scheduledFor),Date.parse(scheduledFor));
  assert.equal(history[2].changes.after.order.scheduledFor,null);
});

test('invalid creation rolls back order, item and history',async()=>{
  const productId=await product();
  for(const extra of [{quantity:0},{quantity:-1},{quantity:2147483647},
    {unitPriceCents:-1},{depositRequiredCents:-1},{contactPhoneNumber:''},
    {contactPhoneNumber:'+1 9055550133'},{contactPhoneNumber:'+0123'},
    {clientId:uuid()},{productId:uuid()}]) {
    const vars={id:uuid(),itemId:uuid(),productId,quantity:2,...extra};
    await denied('CreateOrder',vars);
    assert.equal((await get(vars.id)).order,null);
    assert.equal((await events(vars.id)).length,0);
    assert.equal((await ok('ListOrderItems',{id:vars.id})).orderItems.length,0);
  }
});

test('item changes preserve snapshots and manual checkout total; last item cannot be removed',async()=>{
  const value=await create();
  await ok('UpdateOrderPricing',{id:value.id,expectedRevision:0,discountCents:100,depositRequiredCents:500,finalTotalCents:2500});
  const second=uuid();
  await ok('AddOrderItem',{id:value.id,expectedRevision:1,itemId:second,productId:value.productId,quantity:1,unitPriceCents:750});
  await ok('UpdateOrderItem',{id:value.id,expectedRevision:2,itemId:value.itemId,quantity:3,unitPriceCents:900,notes:'extra'});
  let current=(await get(value.id)).order;
  assert.equal(current.subtotalCents,3450);
  assert.equal(current.finalTotalCents,2500);
  const lines=(await ok('ListOrderItems',{id:value.id})).orderItems;
  assert.equal(lines.find(i=>i.id===value.itemId).catalogUnitPriceCents,1000);
  await ok('UpdateProduct',{id:value.productId,name:'New catalog name',priceCents:9999,isLechon:true,isActive:false,expectedRevision:0},catalogAdmin);
  assert.equal((await ok('ListOrderItems',{id:value.id})).orderItems[0].productName,'Order test product');
  await denied('AddOrderItem',{id:value.id,expectedRevision:3,itemId:uuid(),productId:value.productId,quantity:1});
  await ok('RemoveOrderItem',{id:value.id,expectedRevision:3,itemId:second});
  await denied('RemoveOrderItem',{id:value.id,expectedRevision:4,itemId:value.itemId});
  current=(await get(value.id)).order;
  assert.equal(current.itemCount,1);
  assert.equal(current.revision,4);
  assert.equal((await events(value.id)).length,5);
});

test('invalid pricing, overflow, foreign items and malformed contacts roll back without audit',async()=>{
  const value=await create();
  const other=await create();
  for(const [operation,extra] of [
    ['UpdateOrderPricing',{discountCents:2001,depositRequiredCents:0}],
    ['UpdateOrderPricing',{discountCents:-1,depositRequiredCents:0}],
    ['UpdateOrderPricing',{discountCents:0,depositRequiredCents:-1}],
    ['UpdateOrderPricing',{discountCents:0,depositRequiredCents:0,finalTotalCents:-1}],
    ['UpdateOrderItem',{itemId:value.itemId,quantity:2147483647,unitPriceCents:2147483647}],
    ['UpdateOrderItem',{itemId:other.itemId,quantity:1,unitPriceCents:1}],
    ['RemoveOrderItem',{itemId:other.itemId}],
    ['UpdateOrderContact',{contactPhoneNumber:'bad'}]
  ]) await denied(operation,{id:value.id,expectedRevision:0,...extra});
  assert.equal((await get(value.id)).order.revision,0);
  assert.equal((await events(value.id)).length,1);
});

test('completion is independent of money; completed contact edits allow staff and money requires admin',async()=>{
  const value=await create();
  await ok('CompleteOrder',{id:value.id,expectedRevision:0});
  const completed=(await get(value.id)).order;
  assert.equal(completed.status,'COMPLETED');
  assert.equal((await get(value.id)).financials[0].isEstimate,true);
  await denied('UpdateOrderPricing',{id:value.id,expectedRevision:1,discountCents:0,depositRequiredCents:0,finalTotalCents:500});
  await denied('UpdateOrderItem',{id:value.id,expectedRevision:1,itemId:value.itemId,quantity:3,unitPriceCents:1000});
  await denied('CancelOrder',{id:value.id,expectedRevision:1,cancellationTotalCents:0});
  await ok('UpdateOrderContact',{id:value.id,expectedRevision:1,contactPhoneNumber:'9055550134',notes:'collected'});
  await ok('UpdateOrderPricing',{id:value.id,expectedRevision:2,discountCents:0,depositRequiredCents:500,finalTotalCents:500},admin);
  await ok('RecordCashPayment',{id:value.id,expectedRevision:3,paymentId:uuid(),amountCents:200});
  const current=await get(value.id);
  assert.equal(current.order.completedAt,completed.completedAt);
  assert.equal(current.order.status,'COMPLETED');
  assert.equal(Number(current.financials[0].balanceCents),300);
  const clientId=uuid();
  await ok('CreateClient',{id:clientId,phoneNumber:'9055550135'});
  await denied('AssignOrderClient',{id:value.id,expectedRevision:4,clientId,finalTotalCents:1});
  await ok('AssignOrderClient',{id:value.id,expectedRevision:4,clientId});
  const assigned=(await get(value.id)).order;
  assert.equal(assigned.clientId,clientId);
  assert.equal(assigned.contactPhoneNumber,'+19055550134');
  assert.equal(assigned.finalTotalCents,500);
  const history=await events(value.id);
  assert.equal(history.at(-1).actorUid,staff.sub);
  assert.deepEqual(history.at(-1).changes.before,{order:{clientId:null}});
  assert.deepEqual(history.at(-1).changes.after,{order:{clientId}});
  assert.equal(history[3].actorUid,admin.sub);
  assert.equal(history[3].changes.before.order.finalTotalCents,null);
  assert.equal(history[3].changes.after.order.finalTotalCents,500);
});

test('cash payments, partial refunds, void corrections and overpayments preserve history',async()=>{
  const value=await create();
  const paymentId=uuid(),refundId=uuid();
  await ok('RecordCashPayment',{id:value.id,expectedRevision:0,paymentId,amountCents:3000});
  assert.equal(Number((await get(value.id)).financials[0].balanceCents),-1000);
  await denied('RefundCashPayment',{id:value.id,expectedRevision:1,paymentId,refundId,amountCents:1000});
  await ok('RefundCashPayment',{id:value.id,expectedRevision:1,paymentId,refundId,amountCents:1000},admin);
  await denied('RefundCashPayment',{id:value.id,expectedRevision:2,paymentId,refundId:uuid(),amountCents:2001},admin,/REFUND_EXCEEDS_PAYMENT/);
  await denied('VoidCashPayment',{id:value.id,expectedRevision:2,paymentId},admin,/PAYMENT_HAS_REFUNDS/);
  await denied('VoidCashRefund',{id:value.id,expectedRevision:2,refundId});
  await ok('VoidCashRefund',{id:value.id,expectedRevision:2,refundId},admin);
  await denied('VoidCashPayment',{id:value.id,expectedRevision:3,paymentId});
  await ok('VoidCashPayment',{id:value.id,expectedRevision:3,paymentId},admin);
  const financials=(await get(value.id)).financials[0];
  assert.equal(Number(financials.netPaidCents),0);
  assert.equal((await ok('ListOrderPayments',{id:value.id})).payments[0].amountCents,3000);
  assert.equal((await ok('ListOrderPayments',{id:value.id})).payments[0].status,'VOIDED');
  assert.equal((await ok('ListOrderRefunds',{id:value.id})).refunds[0].status,'VOIDED');
  const history=await events(value.id);
  assert.deepEqual(history.map(e=>e.orderRevision),[0,1,2,3,4]);
  assert.equal(history[1].changes.after.payment.amountCents,3000);
  assert.equal(history[4].changes.before.payment.status,'SUCCEEDED');
  assert.equal(history[4].changes.after.payment.status,'VOIDED');
});

test('cancellation has explicit settlement and never creates an automatic refund',async()=>{
  const value=await create();
  await ok('UpdateOrderPricing',{id:value.id,expectedRevision:0,discountCents:0,depositRequiredCents:1000,finalTotalCents:3000});
  await ok('RecordCashPayment',{id:value.id,expectedRevision:1,paymentId:uuid(),amountCents:1000});
  await denied('CancelOrder',{id:value.id,expectedRevision:2,cancellationTotalCents:-1});
  await ok('CancelOrder',{id:value.id,expectedRevision:2,cancellationTotalCents:1500});
  let state=await get(value.id);
  assert.equal(state.order.finalTotalCents,3000);
  assert.equal(state.order.status,'CANCELLED');
  assert.equal(Number(state.financials[0].balanceCents),500);
  assert.equal((await ok('ListOrderRefunds',{id:value.id})).refunds.length,0);
  await denied('UpdateOrderContact',{id:value.id,expectedRevision:3,notes:'forbidden'});
  await ok('UpdateCancellationSettlement',{id:value.id,expectedRevision:3,cancellationTotalCents:1000},admin);
  assert.equal(Number((await get(value.id)).financials[0].balanceCents),0);
  await ok('ReopenOrder',{id:value.id,expectedRevision:4},admin);
  state=await get(value.id);
  assert.equal(state.order.cancelledAt,null);
  assert.equal(state.order.cancellationTotalCents,null);
  assert.equal(state.order.status,'CONFIRMED');
});

test('concurrent changes commit one revision and one event; retries never duplicate money',async()=>{
  const value=await create();
  const results=await Promise.all([100,200].map(amountCents=>call('RecordCashPayment',{
    id:value.id,expectedRevision:0,paymentId:uuid(),amountCents
  })));
  assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));
  assert.equal((await events(value.id)).length,2);
  const payment=(await ok('ListOrderPayments',{id:value.id})).payments[0];
  await denied('RecordCashPayment',{id:value.id,expectedRevision:1,paymentId:payment.id,amountCents:payment.amountCents});
  assert.equal((await get(value.id)).order.revision,1);
  assert.equal((await events(value.id)).length,2);
  const refundId=uuid();
  const refunds=await Promise.all([uuid(),refundId].map(refundId=>call('RefundCashPayment',{
    id:value.id,expectedRevision:1,paymentId:payment.id,refundId,amountCents:payment.amountCents
  },admin)));
  assert.equal(refunds.filter(r=>r.ok).length,1,JSON.stringify(refunds));
  assert.equal(Number((await get(value.id)).financials[0].netPaidCents),0);
});

test('refund/payment ownership, positive amounts and existing rows are required',async()=>{
  const a=await create(),b=await create();
  const paymentId=uuid();
  await ok('RecordCashPayment',{id:a.id,expectedRevision:0,paymentId,amountCents:100});
  await denied('RefundCashPayment',{id:b.id,expectedRevision:0,paymentId,refundId:uuid(),amountCents:1},admin);
  for(const amountCents of [0,-1]) {
    await denied('RecordCashPayment',{id:b.id,expectedRevision:0,paymentId:uuid(),amountCents});
    await denied('RefundCashPayment',{id:a.id,expectedRevision:1,paymentId,refundId:uuid(),amountCents},admin);
  }
  await denied('UpdateOrderContact',{id:uuid(),expectedRevision:0},staff,/ORDER_CONFLICT/);
  assert.equal((await get(b.id)).order.revision,0);
});

test('every order operation rejects missing, incorrect-provider and non-Boolean roles',async()=>{
  const value=await create();
  const base={id:value.id,expectedRevision:0};
  const vars={
    GetOrder:{id:value.id},GetOrderByNumber:{orderNumber:(await get(value.id)).order.orderNumber},
    GetOrdersByPhoneNumber:{phoneNumber:'9055550131'},ListOrders:{},
    ListOrderItems:{id:value.id},ListOrderPayments:{id:value.id},ListOrderRefunds:{id:value.id},ListOrderAuditEvents:{id:value.id},
    CreateOrder:{id:uuid(),itemId:uuid(),productId:value.productId,quantity:1},
    AssignOrderClient:base,UpdateOrderContact:base,UpdateOrderSchedule:base,
    UpdateOrderPricing:{...base,discountCents:0,depositRequiredCents:0,finalTotalCents:1000},
    AddOrderItem:{...base,itemId:uuid(),productId:value.productId,quantity:1},
    UpdateOrderItem:{...base,itemId:value.itemId,quantity:1,unitPriceCents:1000},
    RemoveOrderItem:{...base,itemId:value.itemId},MarkOrderPaid:base,CompleteOrder:base,
    CancelOrder:{...base,cancellationTotalCents:0},ReopenOrder:base,
    UpdateCancellationSettlement:{...base,cancellationTotalCents:0},
    RecordCashPayment:{...base,paymentId:uuid(),amountCents:100},
    RefundCashPayment:{...base,paymentId:uuid(),refundId:uuid(),amountCents:100},
    VoidCashPayment:{...base,paymentId:uuid()},VoidCashRefund:{...base,refundId:uuid()}
  };
  for(const claims of [null,{sub:'customer',firebase:{sign_in_provider:'google.com'}},{...staff,staff:'true'},{...admin,admin:1},{...catalogAdmin,firebase:{sign_in_provider:'password'}}]) {
    for(const [operation,variables] of Object.entries(vars)) {
      const result=await call(operation,variables,claims);
      assert.equal(result.ok,false,`${operation}: ${JSON.stringify(result.body)}`);
      assert.doesNotMatch(JSON.stringify(result.body),/not expected|ORDER_VALIDATION|ORDER_CONFLICT|ORDER_FORBIDDEN|compile/i);
    }
  }
  assert.equal((await get(value.id)).order.revision,0);
  assert.equal((await events(value.id)).length,1);
});

test('balances include receipts beyond one page and history pages keep revision order',async()=>{
  const value=await create();
  for(let revision=0;revision<102;revision++) {
    await ok('RecordCashPayment',{id:value.id,expectedRevision:revision,paymentId:uuid(),amountCents:1});
  }
  const first=(await ok('ListOrderPayments',{id:value.id})).payments;
  const second=(await ok('ListOrderPayments',{id:value.id,offset:100})).payments;
  assert.equal(first.length,100);
  assert.equal(second.length,2);
  assert.equal(new Set([...first,...second].map(p=>p.id)).size,102);
  assert.equal(Number((await get(value.id)).financials[0].netPaidCents),102);
  const initial=(await events(value.id));
  const final=(await ok('ListOrderAuditEvents',{id:value.id,offset:100})).orderAuditEvents;
  assert.equal(initial.length,100);
  assert.deepEqual(final.map(e=>e.orderRevision),[100,101,102]);
});

test('completion racing a staff price change cannot allow a post-completion price edit',async()=>{
  const value=await create();
  const results=await Promise.all([
    call('CompleteOrder',{id:value.id,expectedRevision:0}),
    call('UpdateOrderPricing',{id:value.id,expectedRevision:0,discountCents:0,depositRequiredCents:0,finalTotalCents:500})
  ]);
  assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));
  if((await get(value.id)).order.status==='CONFIRMED') await ok('CompleteOrder',{id:value.id,expectedRevision:1});
  const current=(await get(value.id)).order;
  await denied('UpdateOrderPricing',{id:value.id,expectedRevision:current.revision,discountCents:0,depositRequiredCents:0,finalTotalCents:1});
});

test('staff and admins manually mark paid without creating receipts or checking the balance',async()=>{
  for(const claims of [staff,admin]) {
    const value=await create();
    const before=await get(value.id);
    const result=await ok('MarkOrderPaid',{id:value.id,expectedRevision:0},claims);
    assert.equal(result.result.order.status,'PAID');
    assert.equal(result.result.order.revision,1);
    assert.equal(result.result.order.completedAt,null);
    const current=await get(value.id);
    assert.equal(current.order.finalTotalCents,null);
    assert.equal(current.financials[0].balanceCents,before.financials[0].balanceCents);
    assert.equal((await ok('ListOrderPayments',{id:value.id})).payments.length,0);
    const history=await events(value.id);
    assert.equal(history.at(-1).action,'ORDER_MARKED_PAID');
    assert.equal(history.at(-1).actorUid,claims.sub);
    assert.deepEqual(history.at(-1).changes,{before:{order:{status:'CONFIRMED'}},after:{order:{status:'PAID'}}});
    await denied('MarkOrderPaid',{id:value.id,expectedRevision:1},claims,/ORDER_FORBIDDEN/);
    assert.equal((await events(value.id)).length,2);
    await ok('CompleteOrder',{id:value.id,expectedRevision:1});
    await denied('MarkOrderPaid',{id:value.id,expectedRevision:2},admin,/ORDER_FORBIDDEN/);
  }
});

test('paid remains an active editable order and money changes never toggle it automatically',async()=>{
  const value=await create();
  const paymentId=uuid();
  await ok('UpdateOrderPricing',{id:value.id,expectedRevision:0,discountCents:0,depositRequiredCents:1000,finalTotalCents:2000});
  await ok('RecordCashPayment',{id:value.id,expectedRevision:1,paymentId,amountCents:2000});
  assert.equal((await get(value.id)).order.status,'CONFIRMED');
  await ok('MarkOrderPaid',{id:value.id,expectedRevision:2});
  await ok('UpdateOrderPricing',{id:value.id,expectedRevision:3,discountCents:0,depositRequiredCents:1000,finalTotalCents:3000});
  await ok('UpdateOrderItem',{id:value.id,expectedRevision:4,itemId:value.itemId,quantity:3,unitPriceCents:1000});
  await ok('RefundCashPayment',{id:value.id,expectedRevision:5,paymentId,refundId:uuid(),amountCents:100},admin);
  const current=await get(value.id);
  assert.equal(current.order.status,'PAID');
  assert.equal(Number(current.financials[0].balanceCents),1100);
  await denied('ReopenOrder',{id:value.id,expectedRevision:6});
  await ok('ReopenOrder',{id:value.id,expectedRevision:6},admin);
  assert.equal((await get(value.id)).order.status,'CONFIRMED');
  await ok('MarkOrderPaid',{id:value.id,expectedRevision:7});
  await ok('CancelOrder',{id:value.id,expectedRevision:8,cancellationTotalCents:1900});
  assert.equal((await get(value.id)).order.status,'CANCELLED');
  await denied('MarkOrderPaid',{id:value.id,expectedRevision:9},admin,/ORDER_FORBIDDEN/);
});

test('manual paid transition checks revisions and concurrent attempts produce one audit event',async()=>{
  const value=await create();
  await denied('MarkOrderPaid',{id:value.id,expectedRevision:1},staff,/ORDER_CONFLICT/);
  await denied('MarkOrderPaid',{id:uuid(),expectedRevision:0},staff,/ORDER_CONFLICT/);
  const attempts=await Promise.all([staff,admin].map(claims=>call('MarkOrderPaid',{id:value.id,expectedRevision:0},claims)));
  assert.equal(attempts.filter(r=>r.ok).length,1,JSON.stringify(attempts));
  assert.equal((await events(value.id)).length,2);
  assert.equal((await get(value.id)).order.revision,1);
});
