import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import pg from 'pg';

assert.equal(process.env.GCLOUD_PROJECT, 'demo-mtl');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
const pool = new pg.Pool({connectionString: 'postgresql://postgres:test-only@127.0.0.1:15432/restaurant'});
const base = 'http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/manageReportEntries';
const google = {sign_in_provider: 'google.com'};
const admin = {sub: 'report-admin', name: 'Anna Reyes', firebase: google, admin: true};

function token(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({alg: 'none', typ: 'JWT'})}.${encode({
    aud: 'demo-mtl', iss: 'https://securetoken.google.com/demo-mtl', iat: now, exp: now + 3600, ...claims,
  })}.`;
}
async function call(data, claims = admin) {
  const headers = {'Content-Type': 'application/json'};
  if (claims) headers.Authorization = `Bearer ${token(claims)}`;
  const response = await fetch(base, {method: 'POST', headers, body: JSON.stringify({data})});
  return response.json();
}
const list = (claims = admin, after = null) => call({
  actorID: claims?.sub ?? admin.sub, action: 'list', startDay: '2026-11-01', endDay: '2026-12-01', after,
}, claims);
const write = (change, claims = admin) => call({actorID: claims.sub, action: change.action, change}, claims);
const create = (fields = {}) => ({action: 'create', entryID: randomUUID(), requestID: randomUUID(),
  day: '2026-11-01', type: 'totalCash', amountCents: 5000, ...fields});

before(async () => {
  const response = await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'x-firebase-auth-token': token(admin)},
    body: JSON.stringify({operationName: 'ListProducts', variables: {}}),
  });
  assert.equal(response.ok, true);
  await pool.query(await readFile(new URL('../../../migrations/report-constraints.sql', import.meta.url), 'utf8'));
});
after(() => pool.end());

test('authorizes Google Admin claims at the callable and starts with an empty ledger', async () => {
  assert.deepEqual((await list()).result, {entries: [], next: null});
  assert.deepEqual((await list({...admin, staff: true})).result, {entries: [], next: null});
  assert.equal((await list({...admin, staff: true, admin: false})).error?.status, 'PERMISSION_DENIED');
  assert.equal((await list({...admin, firebase: {sign_in_provider: 'password'}})).error?.status, 'PERMISSION_DENIED');
  assert.equal((await list(null)).error?.status, 'UNAUTHENTICATED');
});

test('replays lost responses, protects concurrent edits and retains the delete snapshot', async () => {
  const request = create({notes: '  original  '});
  // Commit the first response but deliberately do not use it.
  await write(request);
  const created = (await write(request)).result?.entry;
  assert.equal(created?.revision, 0);
  assert.equal(created?.notes, 'original');
  assert.equal(created?.enteredBy, 'Anna Reyes');
  assert.equal((await write({...request, amountCents: 3})).error?.status, 'ALREADY_EXISTS');

  const other = {...admin, sub: 'second-admin', name: 'Joel'};
  assert.equal((await write(request, other)).error?.status, 'ALREADY_EXISTS');
  const update = {action: 'update', requestID: randomUUID(), entryID: request.entryID,
    expectedRevision: 0, amountCents: 100, notes: 'updated'};
  const responses = await Promise.all([write(update, other), write({...update, requestID: randomUUID()})]);
  assert.equal(responses.filter(r => r.result?.entry?.revision === 1).length, 1);
  assert.equal(responses.filter(r => r.error?.status === 'ABORTED').length, 1);
  assert.equal((await write({...update, requestID: randomUUID(), expectedRevision: 1, amountCents: -1}))
    .error?.status, 'INVALID_ARGUMENT');

  const deletion = {action: 'delete', requestID: randomUUID(), entryID: request.entryID, expectedRevision: 1};
  const deleted = (await write(deletion)).result?.entry;
  assert.ok(deleted?.deletedAt);
  assert.deepEqual((await write(deletion)).result?.entry, deleted);
  assert.deepEqual((await write(request)).result?.entry, created);
  assert.deepEqual((await list()).result?.entries, []);
  const {rows} = await pool.query(`
    SELECT revision,operation,snapshot->>'notes' AS notes FROM report_entry_change
    WHERE entry_id=$1 ORDER BY revision`, [request.entryID]);
  assert.deepEqual(rows, [
    {revision: 0, operation: 'create', notes: 'original'},
    {revision: 1, operation: 'update', notes: 'updated'},
    {revision: 2, operation: 'delete', notes: 'updated'},
  ]);
});

test('audit write failure rolls back the entry', async () => {
  const request = create();
  await pool.query("ALTER TABLE report_entry_change ADD CONSTRAINT report_test_reject CHECK (actor_uid <> 'rollback-admin')");
  try {
    const response = await write(request, {...admin, sub: 'rollback-admin'});
    assert.equal(response.error?.status, 'INTERNAL');
    const result = await pool.query('SELECT id FROM report_entry WHERE id=$1', [request.entryID]);
    assert.equal(result.rowCount, 0);
  } finally {
    await pool.query('ALTER TABLE report_entry_change DROP CONSTRAINT report_test_reject');
  }
});

test('keyset pagination covers all active rows in the requested range', async () => {
  for (const day of ['2026-10-31', '2026-12-01']) assert.ok((await write(create({day}))).result?.entry);
  await pool.query(`
    INSERT INTO report_entry (id, day, type, amount_cents, creator_uid, entered_by, entered_at, revision)
    SELECT gen_random_uuid(), '2026-11-01', 'weeklyPayroll', n, 'fixture', 'Fixture', now(), 0
    FROM generate_series(1, 101) n`);
  const page = (await list()).result;
  assert.equal(page?.entries.length, 100);
  const final = (await list(admin, page.next)).result;
  assert.equal(final?.entries.length, 1);
  assert.equal(final.next, null);
  assert.equal(new Set([...page.entries, ...final.entries].map(row => row.id)).size, 101);
});
