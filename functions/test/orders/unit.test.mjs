import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateInput,validateTiming,localParts} from '../../lib/orders/booking.js';
import {requireOrderCaller} from '../../lib/orders/service.js';
const input=()=>({id:randomUUID(),items:[{id:randomUUID(),productId:randomUUID(),expectedRevision:0,quantity:1}],clientId:null,contactPhoneNumber:null,scheduledFor:'2030-06-01T18:00:00.000Z',allocations:[{minute:780,pigs:1}],depositRequiredCents:0,notes:null});
test('requires Google and independent Boolean staff/admin claims',()=>{
  for(const token of [{},{staff:'true'},{admin:false},{staff:true}]) assert.throws(()=>requireOrderCaller({uid:'a',token}),{code:'permission-denied'});
  for(const flags of [{staff:true},{admin:true}]) assert.equal(requireOrderCaller({uid:'a',token:{...flags,firebase:{sign_in_provider:'google.com'}}}).uid,'a');
});
test('validates canonical input, normalization, cents, quantities and duplicates',()=>{
  const v=input();v.contactPhoneNumber='4165550123';assert.equal(validateInput(v).contactPhoneNumber,'+14165550123');
  for(const patch of [{depositRequiredCents:0.1},{extra:true},{items:[]},{contactPhoneNumber:''},{allocations:[{minute:660,pigs:19}]}]) assert.throws(()=>validateInput({...input(),...patch}),{code:'invalid-argument'});
  const duplicate=input();duplicate.items.push(duplicate.items[0]);assert.throws(()=>validateInput(duplicate));
});
test('Toronto clock crosses DST and rejects elapsed blocks and non-quarter pickup',()=>{
  assert.deepEqual(localParts(new Date('2030-01-01T16:00:00Z')),{day:'2030-01-01',minute:660,second:0});
  assert.deepEqual(localParts(new Date('2030-06-01T15:00:00Z')),{day:'2030-06-01',minute:660,second:0});
  assert.doesNotThrow(()=>validateTiming(input(),new Date('2030-06-01T16:59:00Z')));
  assert.throws(()=>validateTiming(input(),new Date('2030-06-01T17:00:00Z')),{code:'failed-precondition'});
  assert.throws(()=>validateTiming({...input(),scheduledFor:'2030-06-01T18:01:00Z'},new Date('2030-05-01')));
});
