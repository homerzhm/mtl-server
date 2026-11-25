import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateInput,validateTiming,localParts} from '../../lib/orders/booking.js';
import {requireOrderCaller} from '../../lib/orders/service.js';
import {parseHistoricalOrder} from '../../lib/orders/historical-import.js';
const lechon=randomUUID();
const input=()=>({id:randomUUID(),items:[{id:randomUUID(),productId:randomUUID(),expectedRevision:0,quantity:1}],clientId:null,contactPhoneNumber:null,scheduledFor:'2030-06-01T18:00:00.000Z',expectedSettingsRevision:0,expectedGroups:[{id:lechon,expectedRevision:0}],allocations:[{groupId:lechon,blockMinute:780,quantity:1}],depositRequiredCents:0,notes:null});
test('requires Google and independent Boolean staff/admin claims',()=>{
  for(const token of [{},{staff:'true'},{admin:false},{staff:true}]) assert.throws(()=>requireOrderCaller({uid:'a',token}),{code:'permission-denied'});
  for(const flags of [{staff:true},{admin:true}]) assert.equal(requireOrderCaller({uid:'a',token:{...flags,firebase:{sign_in_provider:'google.com'}}}).uid,'a');
});
test('validates canonical input, normalization, cents, quantities and duplicates',()=>{
  const v=input();v.contactPhoneNumber='4165550123';assert.equal(validateInput(v).contactPhoneNumber,'+14165550123');
  for(const patch of [{depositRequiredCents:0.1},{extra:true},{items:[]},{contactPhoneNumber:''},{allocations:[{groupId:lechon,blockMinute:661,quantity:19}]}]) assert.throws(()=>validateInput({...input(),...patch}),{code:'invalid-argument'});
  const duplicate=input();duplicate.items.push(duplicate.items[0]);assert.throws(()=>validateInput(duplicate));
});
test('Toronto clock crosses DST and rejects elapsed blocks and non-quarter pickup',()=>{
  assert.deepEqual(localParts(new Date('2030-01-01T16:00:00Z')),{day:'2030-01-01',minute:660,second:0});
  assert.deepEqual(localParts(new Date('2030-06-01T15:00:00Z')),{day:'2030-06-01',minute:660,second:0});
  assert.doesNotThrow(()=>validateTiming(input(),new Date('2030-06-01T16:59:00Z')));
  assert.throws(()=>validateTiming(input(),new Date('2030-06-01T17:00:00Z')),{code:'failed-precondition'});
  assert.throws(()=>validateTiming({...input(),scheduledFor:'2030-06-01T18:01:00Z'},new Date('2030-05-01')));
});

test('order actions validate exact positive Int32 cents, revisions and request identity', async()=>{
  const {validateAction}=await import('../../lib/orders/actions.js');
  const v={requestId:randomUUID(),id:randomUUID(),expectedRevision:0,action:'PAYMENT',amountCents:2147483647};
  assert.equal(validateAction(v).amountCents,2147483647);
  for(const patch of [{amountCents:0},{amountCents:-1},{amountCents:1.1},{amountCents:2147483648},{amountCents:'100'},
    {expectedRevision:-1},{expectedRevision:2147483647},{requestId:'bad'},{action:'OTHER'},{action:['PAID'],amountCents:null},
    {action:['PICKUP'],amountCents:null},{extra:true},{action:'PAID',amountCents:100}])
    assert.throws(()=>validateAction({...v,...patch}),{code:'invalid-argument'});
});

test('reopen accepts no payment or cancellation fields',()=>{
  const request={requestId:randomUUID(),id:randomUUID(),expectedRevision:3,action:'REOPEN',amountCents:null};
  assert.deepEqual(validateAction(request),request);
  for (const patch of [{amountCents:1},{amountCents:0},{paymentId:randomUUID()},{refundAmountCents:0},{reason:'test'}])
    assert.throws(()=>validateAction({...request,...patch}),{code:'invalid-argument'});
});
test('configuration validates schedules, immutable-code input and strict admin claims',async()=>{
  const {validateConfiguration,requireBookingAdmin,validateAvailability}=await import('../../lib/orders/capacity.js');
  assert.deepEqual(validateConfiguration({action:'UPDATE_SETTINGS',expectedRevision:0,blockMinutes:[780,660]}).blockMinutes,[660,780]);
  for(const blockMinutes of [[],[660,660],[661],[-15],[1440],[null],[[660]]])
    assert.throws(()=>validateConfiguration({action:'UPDATE_SETTINGS',expectedRevision:0,blockMinutes}),{code:'invalid-argument'});
  const group={action:'CREATE_GROUP',id:randomUUID(),code:'NEW_GROUP',name:'New group',capacityPerBlock:4};
  assert.equal(validateConfiguration(group).capacityPerBlock,4);
  for(const patch of [{capacityPerBlock:0},{capacityPerBlock:1.1},{capacityPerBlock:2147483648},{code:'bad code'},{name:' '},{name:' padded'},{archived:false}])
    assert.throws(()=>validateConfiguration({...group,...patch}),{code:'invalid-argument'});
  for(const flags of [{staff:true},{admin:true},{staff:'true',admin:true},{staff:true,admin:'true'}])
    assert.throws(()=>requireBookingAdmin({uid:'a',token:{...flags,firebase:{sign_in_provider:'google.com'}}}),{code:'permission-denied'});
  assert.equal(requireBookingAdmin({uid:'a',token:{staff:true,admin:true,firebase:{sign_in_provider:'google.com'}}}).uid,'a');
  for(const day of ['2030-02-30','bad','0000-01-01'])assert.throws(()=>validateAvailability({day}),{code:'invalid-argument'});
});
test('group allocations canonicalize identities and reject duplicate slots and group revisions',()=>{
  const v=input(), other=randomUUID();v.expectedGroups.push({id:other,expectedRevision:2});
  v.allocations.push({groupId:other.toUpperCase(),blockMinute:780,quantity:4});
  assert.equal(validateInput(v).allocations.find(a=>a.groupId===other).quantity,4);
  assert.deepEqual(validateInput(v),validateInput({...v,expectedGroups:[...v.expectedGroups].reverse(),allocations:[...v.allocations].reverse()}));
  assert.throws(()=>validateInput({...v,allocations:[...v.allocations,v.allocations[0]]}),{code:'invalid-argument'});
  assert.throws(()=>validateInput({...v,expectedGroups:[...v.expectedGroups,v.expectedGroups[0]]}),{code:'invalid-argument'});
  assert.throws(()=>validateInput({...v,expectedSettingsRevision:-1}),{code:'invalid-argument'});
});

test('received deposits validate independently without changing legacy canonical payloads',()=>{
  const legacy=input(), canonical=validateInput(legacy);
  assert.equal(Object.hasOwn(canonical,'depositReceivedCents'),false);
  // This is the pre-update normalization order used to hash persisted creation requests.
  const expected={id:legacy.id,items:legacy.items,clientId:null,contactPhoneNumber:null,
    scheduledFor:legacy.scheduledFor,allocations:legacy.allocations,expectedSettingsRevision:0,
    expectedGroups:legacy.expectedGroups,depositRequiredCents:0,notes:null};
  assert.equal(JSON.stringify(canonical),JSON.stringify(expected));
  assert.equal(validateInput({...legacy,depositReceivedCents:0}).depositReceivedCents,0);
  assert.equal(validateInput({...legacy,depositReceivedCents:1025}).depositReceivedCents,1025);
  assert.equal(validateInput({...legacy,depositRequiredCents:100}).depositRequiredCents,100);
  for(const amount of [-1,0.1,2147483648,'100',null,undefined])
    assert.throws(()=>validateInput({...legacy,depositReceivedCents:amount}),{code:'invalid-argument'});
  assert.throws(()=>validateInput({...legacy,depositRequiredCents:1,depositReceivedCents:1}),{code:'invalid-argument'});
});

 test('payment edit validation preserves legacy canonical hashes and requires a receipt identity',async()=>{
  const {validateAction}=await import('../../lib/orders/actions.js');
  const legacy={requestId:randomUUID(),id:randomUUID(),expectedRevision:3,action:'PAYMENT',amountCents:100};
  assert.equal(JSON.stringify(validateAction(legacy)),JSON.stringify(legacy));
  const edit={...legacy,action:'PAYMENT_EDIT',paymentId:randomUUID(),amountCents:0};
  assert.deepEqual(validateAction(edit),edit);
  assert.equal(validateAction({...edit,amountCents:2147483647}).amountCents,2147483647);
  for(const patch of [{paymentId:undefined},{paymentId:null},{paymentId:'bad'},{amountCents:null},
    {amountCents:-1},{amountCents:1.1},{amountCents:2147483648},{amountCents:'0'}])
    assert.throws(()=>validateAction({...edit,...patch}),{code:'invalid-argument'});
  assert.throws(()=>validateAction({...legacy,paymentId:edit.paymentId}),{code:'invalid-argument'});
});


import {validateEdit} from '../../lib/orders/edits.js';
import {validateAction} from '../../lib/orders/actions.js';
test('edit validation permits saved snapshots but rejects duplicate IDs and unexpected fields',()=>{
  const {depositRequiredCents,...v}=input();const edit={...v,action:'EDIT',requestId:randomUUID(),expectedRevision:3};
  delete edit.items[0].expectedRevision;
  assert.equal(validateEdit(edit).items[0].expectedRevision,null);
  for(const patch of [{expectedRevision:-1},{items:[edit.items[0],edit.items[0]]},{discountCents:100},{requestId:'bad'}])
    assert.throws(()=>validateEdit({...edit,...patch}),{code:'invalid-argument'});
});
test('cancellation requires explicit refund and retains old canonical action shapes',()=>{
  const old={requestId:randomUUID(),id:randomUUID(),expectedRevision:0,action:'PAID',amountCents:null};
  assert.deepEqual(validateAction(old),old);
  const cancel={...old,action:'CANCEL',refundAmountCents:0,reason:'  changed date  '};
  assert.equal(validateAction(cancel).reason,'changed date');
  for(const patch of [{refundAmountCents:undefined},{refundAmountCents:-1},{refundAmountCents:0.1},{reason:'x'.repeat(1001)}])
    assert.throws(()=>validateAction({...cancel,...patch}),{code:'invalid-argument'});
  assert.throws(()=>validateAction({...old,refundAmountCents:0}),{code:'invalid-argument'});
});

test('historical payload canonicalizes identity and times and rejects invalid money and live booking fields', () => {
  const scheduledFor = '2025-11-01T16:37:04Z';
  const v = {id: randomUUID().toUpperCase(), items: input().items, scheduledFor,
    contactPhoneNumber: '4165550191', payments: [{amountCents: 10000}, {amountCents: 20000}]};
  const parsed = parseHistoricalOrder(v);
  assert.equal(parsed.id, v.id.toLowerCase());
  assert.equal(parsed.contactPhoneNumber, '+14165550191');
  assert.equal(parsed.createdAt, '2025-11-01T16:37:04.000Z');
  assert.deepEqual(parsed.payments, v.payments.map(payment => ({...payment, receivedAt: parsed.scheduledFor})));
  assert.deepEqual(parseHistoricalOrder({...v, payments: []}).payments, []);
  for (const patch of [{scheduledFor: '2025-02-30T16:00:00Z'}, {scheduledFor: '0000-01-01T00:00:00Z'},
    {createdAt: '2025-11-02T16:00:00Z'}, {payments: null}, {payments: [{amountCents: 0}]},
    {payments: [{amountCents: 2147483648}]}, {payments: [{amountCents: 1.1}]},
    {payments: [{amountCents: 100, receivedAt: '2025-11-02T16:00:00Z'}]}, {allocations: []},
    {items: [v.items[0], {...v.items[0], id: randomUUID()}]}]) {
    assert.throws(() => parseHistoricalOrder({...v, ...patch}), {code: 'invalid-argument'});
  }
});

test('automatic roast matching keeps early pickup and uses only the corresponding block', async () => {
  const {matchingBlock, blockHasStarted}=await import('../../lib/orders/booking.js');
  const blockMinutes=[660,780,930,1080];
  for (const [pickup, expected] of [[600,660],[645,660],[660,660],[779,660],[840,780],[1439,1080]])
    assert.equal(matchingBlock(blockMinutes,pickup),expected);
  assert.equal(matchingBlock([],600),undefined);
  assert.equal(blockHasStarted('2030-06-01',660,new Date('2030-06-01T15:00:00Z')),true);
  assert.equal(blockHasStarted('2030-06-01',660,new Date('2030-06-01T14:59:00Z')),false);
  const {allocations, expectedSettingsRevision, expectedGroups, ...base}=input();
  const automatic={...base,autoAssignRoastBlock:true,priceOverrideCents:0,scheduledFor:'2030-06-01T14:00:00Z'};
  assert.equal(validateInput(automatic).priceOverrideCents,0);
  assert.equal(validateTiming(validateInput(automatic),new Date('2030-06-01T13:00:00Z')).minute,600);
  assert.throws(()=>validateTiming(validateInput({...automatic,scheduledFor:'2030-06-01T13:45:00Z'}),new Date('2030-06-01T13:00:00Z')),{code:'failed-precondition'});
  for (const patch of [{allocations},{expectedSettingsRevision},{expectedGroups},{priceOverrideCents:-1},{priceOverrideCents:2147483648}])
    assert.throws(()=>validateInput({...automatic,...patch}),{code:'invalid-argument'});
});
