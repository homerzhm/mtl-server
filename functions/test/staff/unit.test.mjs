import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireGoogle, StaffService} from '../../lib/staff/service.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const google = {uid:'user', token:{firebase:{sign_in_provider:'google.com'}}};

test('Google sign-in and strict Boolean admin claims are required', () => {
  for (const caller of [undefined, {uid:'',token:google.token}, {uid:'user',token:{}},
    {uid:'user',token:{firebase:{sign_in_provider:'password'}}}]) {
    assert.throws(() => requireGoogle(caller));
  }
  assert.equal(requireGoogle(google), google);
  for (const admin of [undefined, false, 1, 'true']) {
    assert.throws(() => requireGoogle({...google, token:{...google.token, admin}}, true));
  }
  assert.ok(requireGoogle({...google,token:{...google.token,admin:true}},true));
});

test('malformed role requests and caller-supplied profiles never reach storage', async () => {
  const service = new StaffService({connect(){throw new Error('Unexpected database access');}}, {});
  const actor = {...google,token:{...google.token,admin:true}};
  for (const input of [null, {}, {uid:'a',isStaff:1,isAdmin:true,expectedRevision:0},
    {uid:'a',isStaff:true,isAdmin:true,expectedRevision:-1},
    {uid:'a',isStaff:true,isAdmin:true,expectedRevision:2147483647},
    {uid:'a',isStaff:true,isAdmin:true,expectedRevision:0,actorUid:'forged'}]) {
    await assert.rejects(service.setRoles(actor,input), {code:'invalid-argument'});
  }
  for (const input of [[], 'profile', {isAdmin:true}, {name:'forged'}]) {
    await assert.rejects(service.register(google,input), {code:'invalid-argument'});
  }
});

test('emulator database configuration fails closed and rejects connection-string host overrides', () => {
  const database = fileURLToPath(new URL('../../lib/staff/database.js',import.meta.url));
  for (const url of ['', 'postgresql://remote.example/restaurant',
    'postgresql://127.0.0.1/restaurant?host=remote.example', 'https://127.0.0.1/restaurant']) {
    const result = spawnSync(process.execPath,['-e',`
      const {getPool,closeDatabase}=require(${JSON.stringify(database)});
      getPool().then(()=>{process.exitCode=1;},()=>{}).finally(closeDatabase);
    `], {encoding:'utf8',env:{...process.env,GCLOUD_PROJECT:'demo-mtl',GOOGLE_CLOUD_PROJECT:'demo-mtl',
      FUNCTIONS_EMULATOR:'true',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',STAFF_LOCAL_DATABASE_URL:url}});
    assert.equal(result.status,0,result.stderr);
  }
});

test('trusted setup refuses to run without an explicit project', () => {
  const result = spawnSync(process.execPath,[fileURLToPath(new URL('../../lib/staff/setup.js',import.meta.url))],{encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Pass --project explicitly/);
});
