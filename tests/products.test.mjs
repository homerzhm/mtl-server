import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.env.DATA_CONNECT_EMULATOR_HOST ?? '127.0.0.1:9399';
const service = `http://${origin}/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant`;
const admin = { sub: 'admin', staff: true, admin: true, firebase: { sign_in_provider: 'google.com' } };
function token(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ aud: 'demo-mtl', iss: 'https://securetoken.google.com/demo-mtl', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600, ...claims })}.`;
}
async function call(operationName, variables = {}, claims = admin, mutation = false) {
  if (operationName === "ListProducts") variables = { offset: 0, ...variables };
  const headers = { 'Content-Type': 'application/json' };
  if (claims) headers["x-firebase-auth-token"] = token(claims);
  const response = await fetch(`${service}/connectors/staff-admin:execute${mutation ? 'Mutation' : 'Query'}`, {
    method: 'POST', headers, body: JSON.stringify({ operationName, variables })
  });
  const body = await response.json();
  return { ok: response.ok && !(body.errors?.length), status: response.status, body };
}
const draft = () => ({ id: randomUUID(), name: 'Emulator test', chineseName: '测试', priceCents: 20001, capacityGroupId: null, isActive: true });

test('admin can list products', async () => {
  const result = await call('ListProducts');
  assert.equal(result.ok, true, JSON.stringify(result.body));
});

const denied = [null, { sub: 'staff', staff: true, firebase: { sign_in_provider: 'google.com' } },
  { ...admin, staff: false }, { ...admin, admin: false }, { ...admin, staff: 1 },
  { ...admin, admin: 'true' }, { ...admin, firebase: { sign_in_provider: 'password' } }];
for (const [index, claims] of denied.entries()) {
  test(`writes deny unauthorized caller ${index}`, async () => {
    const value = draft();
    for (const [operation, variables, mutation] of [
      ['CreateProduct', value, true], ['UpdateProduct', {...value, expectedRevision:0}, true]
    ]) {
      const result = await call(operation, variables, claims, mutation);
      assert.equal(result.ok, false, `${operation}: ${JSON.stringify(result.body)}`);
    }
  });
}

test('signed-in users can list and get products without admin access', async () => {
  const value = draft();
  assert.equal((await call('CreateProduct', value, admin, true)).ok, true);
  const readers = [
    ...denied.filter(Boolean),
    { sub: 'customer', firebase: { sign_in_provider: 'google.com' } },
    { sub: 'customer', firebase: { sign_in_provider: 'password' } }
  ];
  for (const claims of readers) {
    const listed = await call('ListProducts', {}, claims);
    assert.equal(listed.ok, true, JSON.stringify(listed.body));
    const fetched = await call('GetProduct', { id: value.id }, claims);
    assert.equal(fetched.ok, true, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.product.name, value.name);
  }
});

test('list and get deny signed-out callers', async () => {
  for (const [operation, variables] of [
    ['ListProducts', {}], ['GetProduct', { id: randomUUID() }]
  ]) {
    const result = await call(operation, variables, null);
    assert.equal(result.ok, false, `${operation}: ${JSON.stringify(result.body)}`);
  }
});

test('create, fetch, update, hide, and clear optional Chinese name', async () => {
  const value = draft();
  const created = await call('CreateProduct', value, admin, true);
  assert.equal(created.ok, true, JSON.stringify(created.body));
  const fetched = await call('GetProduct', {id:value.id});
  assert.equal(fetched.body.data.product.priceCents, 20001);
  assert.equal(fetched.body.data.product.revision, 0);
  const saved = await call('UpdateProduct', {...value, chineseName:null, isActive:false, expectedRevision:0}, admin, true);
  assert.equal(saved.ok, true, JSON.stringify(saved.body));
  const latest = (await call('GetProduct', {id:value.id})).body.data.product;
  assert.equal(latest.revision, 1);
  assert.equal(latest.chineseName, null);
  assert.equal(latest.isActive, false);
  assert.equal(latest.createdAt, fetched.body.data.product.createdAt);
  const duplicate = await call('CreateProduct', value, admin, true);
  assert.equal(duplicate.ok, false);
});

test('two simultaneous edits: exactly one commits', async () => {
  const value = draft();
  assert.equal((await call('CreateProduct', value, admin, true)).ok, true);
  const results = await Promise.all([30,40].map(priceCents =>
    call('UpdateProduct', {...value, priceCents, expectedRevision:0}, admin, true)));
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  assert.match(JSON.stringify(results.find(result => !result.ok).body), /PRODUCT_CONFLICT/);
  assert.equal((await call('GetProduct', {id:value.id})).body.data.product.revision, 1);
});

test('validation rolls back invalid creates and updates', async () => {
  for (const invalid of [{name:'   '}, {name:' leading'}, {priceCents:-1}, {chineseName:''}]) {
    const value = {...draft(), ...invalid};
    const result = await call('CreateProduct', value, admin, true);
    assert.equal(result.ok, false, JSON.stringify(result.body));
    assert.equal((await call('GetProduct', {id:value.id})).body.data.product, null);
  }
  const value = draft();
  assert.equal((await call('CreateProduct', value, admin, true)).ok, true);
  assert.equal((await call('UpdateProduct', {...value, priceCents:-1, expectedRevision:0}, admin, true)).ok, false);
  const latest = (await call('GetProduct', {id:value.id})).body.data.product;
  assert.equal(latest.priceCents, value.priceCents);
  assert.equal(latest.revision, 0);
});

test('missing update fails without inserting; zero prices and duplicate names are valid', async () => {
  const missing = draft();
  assert.equal((await call('UpdateProduct', {...missing, expectedRevision:0}, admin, true)).ok, false);
  assert.equal((await call('GetProduct', {id:missing.id})).body.data.product, null);
  for (let i=0;i<2;i++) {
    assert.equal((await call('CreateProduct', {...draft(), name:'Same name', priceCents:0}, admin, true)).ok, true);
  }
});

test('editing preserves server-owned description', async () => {
  const value = draft();
  assert.equal((await call('CreateProduct', value, admin, true)).ok, true);
  async function privileged(query) {
    const response = await fetch(`${service}:executeGraphql`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query})
    });
    return response.json();
  }
  const seeded = await privileged(`mutation { product_update(id: "${value.id}", data: {description: "Preserve me"}) }`);
  assert.equal(seeded.errors?.length ?? 0, 0, JSON.stringify(seeded));
  assert.equal((await call('UpdateProduct', {...value, name:'Renamed', expectedRevision:0}, admin, true)).ok, true);
  const result = await privileged(`query { product(id: "${value.id}") { description } }`);
  assert.equal(result.data.product.description, 'Preserve me', JSON.stringify(result));
});

test('catalog paging includes products beyond the default 100-row limit', async () => {
  const values = Array.from({length:105}, draft);
  for (let start=0;start<values.length;start+=10) {
    const results = await Promise.all(values.slice(start,start+10).map(value => call('CreateProduct',value,admin,true)));
    assert.ok(results.every(result=>result.ok));
  }
  const ids = new Set();
  for (let offset=0;;offset+=100) {
    const result = await call('ListProducts',{offset});
    assert.equal(result.ok,true,JSON.stringify(result.body));
    const page = result.body.data.products;
    page.forEach(product=>ids.add(product.id.replaceAll('-', '').toLowerCase()));
    if (page.length<100) break;
  }
  assert.ok(values.every(value=>ids.has(value.id.replaceAll('-', '').toLowerCase())), `Returned ${ids.size} IDs; missing ${values.filter(value=>!ids.has(value.id.replaceAll('-', '').toLowerCase())).length}`);
});

test('listing remains compatible with callers omitting offset', async () => {
  const response = await fetch(`${service}/connectors/staff-admin:executeQuery`, {
    method: 'POST', headers: {'Content-Type':'application/json','x-firebase-auth-token':token(admin)},
    body: JSON.stringify({operationName:'ListProducts'})
  });
  const body = await response.json();
  assert.equal(response.ok,true,JSON.stringify(body));
  assert.equal(body.errors?.length ?? 0,0,JSON.stringify(body));
  assert.ok(Array.isArray(body.data.products));
});
