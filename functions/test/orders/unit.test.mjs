import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateInput,validateTiming,localParts} from '../../lib/orders/booking.js';
import {requireOrderCaller} from '../../lib/orders/service.js';
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
