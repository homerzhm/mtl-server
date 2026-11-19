import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {target, checkActor, request, main} from './firebase.mjs';

const actor = {aud: 'mtl-service-e3e0c', iss: 'https://securetoken.google.com/mtl-service-e3e0c', sub: 'test-actor', email: 'homerzhm@gmail.com', staff: true, exp: Math.floor(Date.now()/1000)+3600, firebase: {sign_in_provider: 'google.com'}};
const s = {project: actor.aud, region: 'northamerica-northeast1', token: 'FAKE-TEST-TOKEN', apiKey: 'FAKE-TEST-KEY'};
test('requires explicit target and rejects the wrong project, provider, account and nonboolean role', () => {
  assert.throws(() => target(undefined));
  assert.equal(target('production').project, 'mtl-service-production');
  for (const change of [{aud: 'mtl-service-production'}, {staff: 'true'}, {email: 'other@example.com'}, {firebase: {sign_in_provider: 'custom'}}, {exp: 1}]) assert.throws(() => checkActor({...actor, ...change}, actor.aud));
  checkActor(actor, actor.aud);
});
test('connector uses app authentication and the selected environment', async () => {
  let seen;
  const result = await request(s, 'query', 'GetClientByPhoneNumber', {phoneNumber: '+16476274814'}, async (url, options) => {
    seen = {url, options}; return {ok: true, json: async () => ({data: {clients: []}})};
  });
  assert.deepEqual(result, {clients: []});
  assert.match(seen.url, /projects\/mtl-service-e3e0c\/locations\/northamerica-northeast1/);
  assert.equal(seen.options.headers['x-firebase-auth-token'], s.token);
  assert.equal(JSON.parse(seen.options.body).operationName, 'GetClientByPhoneNumber');
});
test('order callable uses data envelope and catches errors even with HTTP 200', async () => {
  await assert.rejects(request(s, 'callable', 'createStaffOrder', {id: 'stable'}, async (url, options) => {
    assert.equal(url, 'https://northamerica-northeast1-mtl-service-e3e0c.cloudfunctions.net/createStaffOrder');
    assert.equal(options.headers.Authorization, `Bearer ${s.token}`);
    assert.deepEqual(JSON.parse(options.body), {data: {id: 'stable'}});
    return {ok: true, status: 200, json: async () => ({error: {status: 'RESOURCE_EXHAUSTED', message: 'GROUP_CAPACITY'}})};
  }), /GROUP_CAPACITY/);
  await assert.rejects(request(s, 'mutation', 'CreateOrder', {}, () => {throw new Error('Must not fetch');}), /Only CreateClient/);
});
test('historical imports require an Admin session and use their own approved journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mtl-historical-skill-test-'));
  const oldFile = process.env.MTL_FIREBASE_SESSION_FILE, oldFetch = globalThis.fetch;
  try {
    const sessionFile = join(dir, 'session.json'), inputFile = join(dir, 'request.json'), journalPath = join(dir, 'journal.json');
    async function setAdmin(admin) {
      const token = `e30.${Buffer.from(JSON.stringify({...actor, admin})).toString('base64url')}.FAKE`;
      await writeFile(sessionFile, JSON.stringify({projectId: actor.aud, apiKey: s.apiKey, idToken: token}), {mode: 0o600});
    }
    process.env.MTL_FIREBASE_SESSION_FILE = sessionFile;
    const variables = {id: '5e8db614-b785-4d85-a1fc-6a1df5871c1f', payments: [{amountCents: 10000}, {amountCents: 20000}]};
    const input = {environment: 'dev', kind: 'callable', operation: 'importHistoricalOrder', approved: true, journalPath, variables};
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://northamerica-northeast1-mtl-service-e3e0c.cloudfunctions.net/importHistoricalOrder');
      assert.deepEqual(JSON.parse(options.body), {data: variables});
      return {ok: true, json: async () => ({result: {id: calls === 1 ? 'unexpected' : variables.id}})};
    };
    await writeFile(inputFile, JSON.stringify(input));
    await setAdmin('true');
    await assert.rejects(main(inputFile), /Admin session/);
    await setAdmin(true);
    await writeFile(inputFile, JSON.stringify({...input, approved: false}));
    await assert.rejects(main(inputFile), /user-approved/);
    assert.equal(calls, 0);
    await writeFile(inputFile, JSON.stringify(input));
    await assert.rejects(main(inputFile), /unexpected ID/);
    assert.equal(JSON.parse(await readFile(journalPath)).state, 'uncertain');
    await assert.rejects(main(inputFile), /explicit retry approval/);
    await writeFile(inputFile, JSON.stringify({...input, retryAuthorized: true}));
    assert.deepEqual(await main(inputFile), {id: variables.id});
    assert.deepEqual(await main(inputFile), {id: variables.id});
    assert.equal(calls, 2);
    const rejectedPath = join(dir, 'rejected.json');
    await writeFile(inputFile, JSON.stringify({...input, journalPath: rejectedPath}));
    globalThis.fetch = async () => ({ok: false, status: 400, json: async () =>
      ({error: {status: 'FAILED_PRECONDITION', message: 'CATALOG_CHANGED'}})});
    await assert.rejects(main(inputFile), /CATALOG_CHANGED/);
    assert.equal(JSON.parse(await readFile(rejectedPath)).state, 'rejected');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldFile === undefined) delete process.env.MTL_FIREBASE_SESSION_FILE; else process.env.MTL_FIREBASE_SESSION_FILE = oldFile;
    await rm(dir, {recursive: true, force: true});
  }
});

test('journals uncertain writes, requires explicit retry, preserves actor and payload, and caches success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mtl-skill-test-'));
  const oldFile = process.env.MTL_FIREBASE_SESSION_FILE, oldFetch = globalThis.fetch;
  try {
    const sessionFile = join(dir, 'session.json'), inputFile = join(dir, 'request.json'), journalPath = join(dir, 'journal.json');
    const token = `e30.${Buffer.from(JSON.stringify(actor)).toString('base64url')}.FAKE`;
    await writeFile(sessionFile, JSON.stringify({projectId: actor.aud, apiKey: s.apiKey, idToken: token}), {mode: 0o600});
    process.env.MTL_FIREBASE_SESSION_FILE = sessionFile;
    const input = {environment: 'dev', kind: 'callable', operation: 'createStaffOrder', approved: true, journalPath, variables: {id: 'stable', depositReceivedCents: 10000}};
    let calls = 0;
    globalThis.fetch = async () => {calls++; throw new Error('Connection lost');};
    await writeFile(inputFile, JSON.stringify({...input, approved: false}));
    await assert.rejects(main(inputFile), /user-approved/);
    assert.equal(calls, 0);
    await writeFile(inputFile, JSON.stringify(input));
    await assert.rejects(main(inputFile), /Connection lost/);
    assert.equal(JSON.parse(await readFile(journalPath)).state, 'uncertain');
    assert.ok(!(await readFile(journalPath, 'utf8')).includes(token));
    await assert.rejects(main(inputFile), /explicit retry approval/);
    assert.equal(calls, 1);
    await writeFile(inputFile, JSON.stringify({...input, retryAuthorized: true, variables: {...input.variables, depositReceivedCents: 20000}}));
    await assert.rejects(main(inputFile), /payload mismatch/);
    await writeFile(inputFile, JSON.stringify({...input, retryAuthorized: true}));
    globalThis.fetch = async () => {calls++; return {ok: true, json: async () => ({result: {id: 'stable'}})};};
    assert.deepEqual(await main(inputFile), {id: 'stable'});
    assert.deepEqual(await main(inputFile), {id: 'stable'});
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldFile === undefined) delete process.env.MTL_FIREBASE_SESSION_FILE; else process.env.MTL_FIREBASE_SESSION_FILE = oldFile;
    await rm(dir, {recursive: true, force: true});
  }
});
