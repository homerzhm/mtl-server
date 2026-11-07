import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Deliberately fixed to a local demo service; unsigned tokens are emulator-only.
const service = 'http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant';
const staff = { sub: 'staff', staff: true, firebase: { sign_in_provider: 'google.com' } };
const admin = { sub: 'admin', admin: true, firebase: { sign_in_provider: 'google.com' } };
function token(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ aud: 'demo-mtl', iss: 'https://securetoken.google.com/demo-mtl', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600, ...claims })}.`;
}
async function call(operationName, variables = {}, claims = staff) {
  const headers = { 'Content-Type': 'application/json' };
  if (claims) headers['x-firebase-auth-token'] = token(claims);
  const mutation = ['CreateClient', 'UpdateClient'].includes(operationName);
  const response = await fetch(`${service}/connectors/staff-admin:execute${mutation ? 'Mutation' : 'Query'}`, {
    method: 'POST', headers, body: JSON.stringify({operationName, variables})
  });
  const body = await response.json();
  return { ok: response.ok && !(body.errors?.length), body };
}
let nextPhone = 14165550000;
const draft = () => ({id: randomUUID(), phoneNumber: `+${nextPhone++}`, name: 'Client', email: 'client@example.com'});
async function create(value = draft(), claims = staff) {
  const result = await call('CreateClient', value, claims);
  assert.equal(result.ok, true, JSON.stringify(result.body));
  return value;
}
async function get(phoneNumber) {
  const result = await call('GetClientByPhoneNumber', {phoneNumber});
  assert.equal(result.ok, true, JSON.stringify(result.body));
  return result.body.data.clients[0] ?? null;
}

test('staff and admins can create, list, get, and edit clients', async () => {
  for (const claims of [staff, admin, {...staff, admin:true}]) {
    const value = await create(draft(), claims);
    assert.equal((await call('ListClients', {}, claims)).ok, true);
    const fetched = await call('GetClient', {id:value.id}, claims);
    assert.equal(fetched.ok, true, JSON.stringify(fetched.body));
    const original = fetched.body.data.client;
    assert.equal(original.name, value.name);
    assert.equal(original.email, value.email);
    assert.equal(original.revision, 0);
    const changedPhone = draft().phoneNumber;
    const updated = await call('UpdateClient', {...value, phoneNumber:changedPhone, name:null, email:null, expectedRevision:0}, claims);
    assert.equal(updated.ok, true, JSON.stringify(updated.body));
    assert.equal(await get(value.phoneNumber), null);
    const latest = await get(changedPhone);
    assert.equal(latest.id, original.id);
    assert.equal(latest.createdAt, original.createdAt);
    assert.equal(latest.name, null);
    assert.equal(latest.email, null);
    assert.equal(latest.revision, 1);
  }
});

test('name and email can be omitted on creation', async () => {
  const {id, phoneNumber} = draft();
  await create({id, phoneNumber});
  const result = await get(phoneNumber);
  assert.equal(result.name, null);
  assert.equal(result.email, null);
});

test('every operation rejects unauthorized users', async () => {
  const value = await create();
  const denied = [null, {sub:'customer', firebase:{sign_in_provider:'google.com'}},
    {...staff, staff:false}, {...staff, staff:1}, {...admin, admin:'true'},
    {...staff, firebase:{sign_in_provider:'password'}}];
  for (const claims of denied) {
    for (const [operation, variables] of [
      ['ListClients', {}], ['GetClient', {id:value.id}], ['GetClientByPhoneNumber', {phoneNumber:value.phoneNumber}],
      ['CreateClient', draft()], ['UpdateClient', {...value, name:'Denied', expectedRevision:0}]
    ]) {
      const result = await call(operation, variables, claims);
      assert.equal(result.ok, false, `${operation}: ${JSON.stringify(result.body)}`);
    }
  }
  assert.equal((await get(value.phoneNumber)).revision, 0);
});

test('database rejects duplicate phone numbers, including concurrent inserts', async () => {
  const value = await create();
  const result = await call('CreateClient', {...draft(), phoneNumber:value.phoneNumber});
  assert.equal(result.ok, false, JSON.stringify(result.body));
  assert.equal((await get(value.phoneNumber)).name, value.name);
  const phoneNumber = draft().phoneNumber;
  const results = await Promise.all([draft(),draft()].map(value => call('CreateClient', {...value, phoneNumber})));
  assert.equal(results.filter(result=>result.ok).length, 1, JSON.stringify(results));
});

test('editing to an existing phone rolls back all changes', async () => {
  const first = await create();
  const second = await create();
  const result = await call('UpdateClient', {...second, phoneNumber:first.phoneNumber, name:'Must roll back', expectedRevision:0});
  assert.equal(result.ok, false, JSON.stringify(result.body));
  assert.equal((await get(first.phoneNumber)).name, first.name);
  const unchanged = await get(second.phoneNumber);
  assert.equal(unchanged.name, second.name);
  assert.equal(unchanged.revision, 0);
});

test('malformed phone inserts and edits roll back', async () => {
  for (const phoneNumber of ['', '416555123', '41655512345', '+1 4165551234', '+1-416-555-1234', '+04165551234', '+1', '+1234567890123456', ' +14165551234', '+14165551234\n']) {
    const result = await call('CreateClient', {...draft(), phoneNumber});
    assert.equal(result.ok, false, JSON.stringify(result.body));
    assert.match(JSON.stringify(result.body), /CLIENT_VALIDATION/);
    assert.equal(await get(phoneNumber), null);
  }
  const value = await create();
  const result = await call('UpdateClient', {...value, phoneNumber:'invalid', expectedRevision:0});
  assert.equal(result.ok, false, JSON.stringify(result.body));
  assert.equal((await get(value.phoneNumber)).revision, 0);
  assert.equal(await get('invalid'), null);
});

test('simultaneous edits commit exactly once; missing edits never insert', async () => {
  const value = await create();
  const results = await Promise.all(['First', 'Second'].map(name => call('UpdateClient', {...value, name, expectedRevision:0})));
  assert.equal(results.filter(result=>result.ok).length, 1, JSON.stringify(results));
  assert.match(JSON.stringify(results.find(result=>!result.ok).body), /CLIENT_CONFLICT/);
  assert.equal((await get(value.phoneNumber)).revision, 1);
  const missing = draft();
  const result = await call('UpdateClient', {...missing, expectedRevision:0});
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.body), /CLIENT_CONFLICT/);
  assert.equal(await get(missing.phoneNumber), null);
});

test('paging returns all clients beyond 100 records', async () => {
  const values = Array.from({length:105}, draft);
  for (let start=0;start<values.length;start+=10) {
    await Promise.all(values.slice(start,start+10).map(value=>create(value)));
  }
  const phones = new Set();
  for (let offset=0;;offset+=100) {
    const result = await call('ListClients', {offset});
    assert.equal(result.ok, true, JSON.stringify(result.body));
    const page = result.body.data.clients;
    assert.ok(page.length <= 100);
    page.forEach(client=>phones.add(client.phoneNumber));
    if (page.length<100) break;
  }
  assert.ok(values.every(value=>phones.has(value.phoneNumber)));
});


test('Canadian local and international forms share one unique identity', async () => {
  const value = {...draft(), phoneNumber:'6475550123'};
  await create(value);
  const local = await get('6475550123');
  const international = await get('+16475550123');
  assert.equal(local.id, international.id);
  assert.equal(local.phoneNumber, '+16475550123');
  assert.equal((await call('CreateClient', {...draft(), phoneNumber:'+16475550123'})).ok, false);
  assert.equal((await call('CreateClient', {...draft(), phoneNumber:'6475550123'})).ok, false);
  const updated = await call('UpdateClient', {...value, phoneNumber:'6475550124', expectedRevision:0});
  assert.equal(updated.ok, true, JSON.stringify(updated.body));
  assert.equal(await get('6475550123'), null);
  assert.equal((await get('+16475550124')).id, local.id);
  const other = await create();
  const duplicateEdit = await call('UpdateClient', {...other, phoneNumber:'6475550124', expectedRevision:0});
  assert.equal(duplicateEdit.ok, false);
  assert.equal((await get(other.phoneNumber)).revision, 0);
  const phoneNumber = '6475550125';
  const concurrent = await Promise.all([phoneNumber, '+1'+phoneNumber].map(phoneNumber=>call('CreateClient', {...draft(), phoneNumber})));
  assert.equal(concurrent.filter(result=>result.ok).length, 1, JSON.stringify(concurrent));
});
