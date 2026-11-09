import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initializeApp, deleteApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import pg from 'pg';
import {StaffService} from '../../lib/staff/service.js';

// Fixed loopback/demo endpoints, including SQL; never inherit a cloud target.
assert.equal(process.env.GCLOUD_PROJECT, 'demo-mtl');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
const app = initializeApp({projectId:'demo-mtl'});
const auth = getAuth(app);
const pool = new pg.Pool({connectionString:'postgresql://postgres:test-only@127.0.0.1:15432/restaurant',max:8});
const service = new StaffService(pool,auth);
const google = uid => ({uid,token:{firebase:{sign_in_provider:'google.com'}}});
const actor = uid => ({uid,token:{...google(uid).token,admin:true}});
const roles = (uid,isStaff,isAdmin,expectedRevision=0) => ({uid,isStaff,isAdmin,expectedRevision});
const sql = (query,params=[]) => pool.query(query,params);
const get = async uid => (await sql('SELECT * FROM staff_account WHERE uid=$1',[uid])).rows[0];

async function user({staff=false,admin=false}={}) {
  const uid = randomUUID();
  await auth.importUsers([{uid,email:`${uid}@example.com`,customClaims:{staff,admin,unrelated:'preserve'},
    providerData:[{uid,providerId:'google.com',email:`${uid}@example.com`,displayName:'Google Name',photoURL:'https://example.com/photo.png'}],
    metadata:{lastSignInTime:'2026-11-08T12:00:00Z'}}]);
  await service.register(google(uid),{});
  return uid;
}
async function adminUser() {
  const uid = await user({staff:true,admin:true});
  // Explicit trusted fixture, never client writable.
  await sql('UPDATE staff_account SET is_staff=true,is_admin=true WHERE uid=$1',[uid]);
  return uid;
}
function unsigned(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg:'none',typ:'JWT'})}.${encode({aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',
    iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...claims})}.`;
}
async function query(operationName,variables={},claims) {
  const headers = {'Content-Type':'application/json'};
  if (claims) headers['x-firebase-auth-token'] = unsigned(claims);
  const response = await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery',{
    method:'POST',headers,body:JSON.stringify({operationName,variables}),
  });
  const body = await response.json();
  return {ok:response.ok && !body.errors?.length,body};
}
const claims = (uid,extra={}) => ({sub:uid,firebase:{sign_in_provider:'google.com'},...extra});

before(async () => {
  const result = await query('GetMyStaffAccount',{},claims('initialize'));
  assert.equal(result.ok,true,JSON.stringify(result.body));
});
beforeEach(async () => {
  await sql('TRUNCATE staff_role_control,staff_role_change,staff_account');
});
after(async () => {await pool.end();await deleteApp(app);});

test('registration uses Google profile, stays pending, preserves roles and first-seen time', async () => {
  const uid = await user();
  const first = await get(uid);
  assert.equal(first.name,'Google Name');
  assert.equal(first.email,`${uid}@example.com`);
  assert.equal(first.photo_url,'https://example.com/photo.png');
  assert.equal(first.is_staff,false);
  assert.equal(first.is_admin,false);
  assert.equal(first.last_sign_in_at.toISOString(),'2026-11-08T12:00:00.000Z');
  const admin = await adminUser();
  await service.setRoles(actor(admin),roles(uid,true,false));
  await service.register({...google(uid),token:{...google(uid).token,staff:false,admin:true}},{});
  const next = await get(uid);
  assert.equal(next.created_at.toISOString(),first.created_at.toISOString());
  assert.equal(next.is_staff,true);
  assert.equal(next.is_admin,false);
  assert.equal(next.revision,1);
  await assert.rejects(service.register(google(uid),{isAdmin:true}),{code:'invalid-argument'});
});

test('all independent role combinations synchronize claims and retain unrelated claims', async () => {
  const admin = await adminUser();
  for (const isStaff of [false,true]) for (const isAdmin of [false,true]) {
    const uid = await user();
    const account = await service.setRoles(actor(admin),roles(uid,isStaff,isAdmin));
    assert.equal(account.isStaff,isStaff);
    assert.equal(account.isAdmin,isAdmin);
    assert.equal(account.claimSyncStatus,'APPLIED');
    const updated = await auth.getUser(uid);
    assert.equal(updated.customClaims.staff,isStaff);
    assert.equal(updated.customClaims.admin,isAdmin);
    assert.equal(updated.customClaims.unrelated,'preserve');
  }
});

test('authorization, stale revisions, self-demotion and stale admin tokens are rejected', async () => {
  const admin = await adminUser();
  const uid = await user();
  await assert.rejects(service.setRoles(google(uid),roles(uid,true,true)),{code:'permission-denied'});
  await assert.rejects(service.setRoles(actor(uid),roles(uid,true,true)),{code:'permission-denied'});
  await assert.rejects(service.setRoles(actor(admin),roles(admin,true,false)),/STAFF_SELF_DEMOTION/);
  await assert.rejects(service.setRoles(actor(admin),roles(uid,true,false,9)),/STAFF_CONFLICT/);
  assert.equal((await get(uid)).revision,0);
  assert.equal((await sql('SELECT * FROM staff_role_change')).rowCount,0);
  await sql('UPDATE staff_account SET is_admin=false WHERE uid=$1',[admin]);
  await assert.rejects(service.setRoles(actor(admin),roles(uid,true,true)),{code:'permission-denied'});
});

test('disabled users cannot register or gain roles, but admins can remove their existing roles', async () => {
  const admin = await adminUser();
  const uid = await user();
  await service.setRoles(actor(admin),roles(uid,true,false));
  await auth.updateUser(uid,{disabled:true});
  await assert.rejects(service.register(google(uid),{}),{code:'permission-denied'});
  await assert.rejects(service.setRoles(actor(admin),roles(uid,true,true,1)),{code:'permission-denied'});
  await service.setRoles(actor(admin),roles(uid,false,false,1));
  assert.equal((await auth.getUser(uid)).customClaims.staff,false);
  const history = await query('ListStaffRoleChanges',{uid},claims(admin,{admin:true}));
  assert.equal(history.ok,true,JSON.stringify(history.body));
  assert.deepEqual(history.body.data.staffRoleChanges.map(e=>e.roleRevision),[1,2]);
  assert.ok(history.body.data.staffRoleChanges.every(e=>e.status==='APPLIED'));
});

test('simultaneous updates commit once; concurrent admins cannot demote each other into lockout', async () => {
  const first = await adminUser();
  const second = await adminUser();
  const uid = await user();
  const outcomes = await Promise.allSettled([
    service.setRoles(actor(first),roles(uid,true,false)),service.setRoles(actor(first),roles(uid,false,true)),
  ]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await get(uid)).revision,1);
  // Remove the third account's Admin flag before testing the two-admin race.
  await service.setRoles(actor(first),roles(uid,false,false,1));
  const demotions = await Promise.allSettled([
    service.setRoles(actor(first),roles(second,true,false)),service.setRoles(actor(second),roles(first,true,false)),
  ]);
  assert.equal(demotions.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await sql('SELECT * FROM staff_account WHERE is_admin')).rowCount,1);
});

test('Auth failure is durable, blocks overlapping edits, and reconciliation is idempotent', async () => {
  const admin = await adminUser();
  const uid = await user();
  const failing = new StaffService(pool,{
    getUser:auth.getUser.bind(auth),listUsers:auth.listUsers.bind(auth),
    setCustomUserClaims:async()=>{throw Object.assign(new Error('injected'),{code:'auth/internal-error'});},
  });
  const failed = await failing.setRoles(actor(admin),roles(uid,true,true));
  assert.equal(failed.claimSyncStatus,'FAILED');
  await assert.rejects(service.setRoles(actor(admin),roles(uid,false,false,1)),/STAFF_SYNC_PENDING/);
  assert.equal((await auth.getUser(uid)).customClaims.staff,false);
  const event = (await sql('SELECT * FROM staff_role_change WHERE target_uid=$1',[uid])).rows[0];
  assert.equal(event.status,'FAILED');
  assert.equal(event.attempts,1);
  const retries = await Promise.all([service.reconcile(),service.reconcile()]);
  assert.deepEqual(retries.map(r=>r.status).sort(),['APPLIED','IDLE']);
  assert.equal((await get(uid)).claim_sync_status,'APPLIED');
  assert.equal((await auth.getUser(uid)).customClaims.admin,true);
  assert.equal((await sql('SELECT * FROM staff_role_change WHERE target_uid=$1',[uid])).rowCount,1);
  await service.setRoles(actor(admin),roles(uid,false,false,1));
  assert.equal((await service.reconcile()).status,'IDLE');
  assert.equal((await auth.getUser(uid)).customClaims.admin,false);
});

test('interruption after Auth success rolls SQL back and the persisted request can be replayed', async () => {
  const admin = await adminUser();
  const uid = await user();
  let failFinalization = true;
  const faultPool = {connect:async()=>{
    const db = await pool.connect();
    return {release:()=>db.release(),query:async(text,args)=>{
      if (failFinalization && text.startsWith("UPDATE staff_role_change SET status='APPLIED'")) {
        failFinalization=false;
        throw new Error('Simulated process interruption before finalization');
      }
      return db.query(text,args);
    }};
  }};
  const interrupted = new StaffService(faultPool,auth);
  await assert.rejects(interrupted.setRoles(actor(admin),roles(uid,true,false)),/Simulated process interruption/);
  assert.equal((await get(uid)).claim_sync_status,'PENDING');
  assert.equal((await auth.getUser(uid)).customClaims.staff,true);
  assert.equal((await service.reconcile()).status,'APPLIED');
  assert.equal((await sql('SELECT * FROM staff_role_change WHERE target_uid=$1',[uid])).rowCount,1);
});

test('imports preserve existing roles, record history, and explicit bootstrap is required', async () => {
  // Clear Auth so import tests do not depend on users from previous tests.
  await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-mtl/accounts',{method:'DELETE'});
  await assert.rejects(service.ensureAdmin(),/No admin exists/);
  const admin = await user({staff:false,admin:true});
  const staff = await user({staff:true,admin:false});
  await sql('DELETE FROM staff_account WHERE uid=ANY($1::text[])',[[admin,staff]]);
  assert.equal(await service.importExisting(),2);
  assert.equal(await service.importExisting(),0);
  await service.ensureAdmin();
  assert.equal((await get(admin)).is_staff,false);
  assert.equal((await get(admin)).is_admin,true);
  const pending = await user();
  await service.importExisting();
  assert.equal((await get(pending)).is_admin,false);
  await sql('TRUNCATE staff_role_control,staff_role_change,staff_account');
  await service.ensureAdmin(pending);
  assert.equal((await get(pending)).is_admin,true);
  assert.equal((await auth.getUser(pending)).customClaims.staff,true);
  await service.ensureAdmin(pending);
  assert.equal((await sql('SELECT * FROM staff_role_change')).rowCount,1);
});

test('directory privacy, self-only pending reads, role gates and pagination are enforced', async () => {
  const pending = await user();
  const approved = await adminUser();
  for (let n=0;n<105;n++) await sql(`INSERT INTO staff_account
    (uid,name,email,is_staff,is_admin,revision,claim_sync_status,created_at)
    VALUES ($1,'Staff','visible@example.com',true,false,0,'APPLIED',now())`,[`directory-${n}`]);
  const own = await query('GetMyStaffAccount',{},claims(pending));
  assert.equal(own.body.data.staffAccount.uid,pending);
  assert.equal(Object.hasOwn(own.body.data.staffAccount,'lastSignInAt'),false);
  for (const denied of [undefined,claims(pending),claims(pending,{staff:'true'}),
    {...claims(pending,{admin:true}),firebase:{sign_in_provider:'password'}}]) {
    assert.equal((await query('ListStaffDirectory',{},denied)).ok,false);
    assert.equal((await query('ListStaffAccounts',{},denied)).ok,false);
    assert.equal((await query('ListStaffRoleChanges',{uid:approved},denied)).ok,false);
  }
  assert.equal((await query('ListStaffAccounts',{},claims(approved,{staff:true}))).ok,false);
  for (const role of [{staff:true},{admin:true},{staff:true,admin:true}]) {
    const all = [];
    for(let offset=0;;offset+=100) {
      const result = await query('ListStaffDirectory',{offset},claims(approved,role));
      assert.equal(result.ok,true,JSON.stringify(result.body));
      const page = result.body.data.staffAccounts;
      all.push(...page);
      if(page.length<100) break;
    }
    assert.equal(all.length,106);
    assert.equal(all.some(p=>p.uid===pending),false);
    assert.deepEqual(Object.keys(all[0]).sort(),['uid','name','email','photoUrl','isStaff','isAdmin'].sort());
  }
  const listed = await query('ListStaffAccounts',{},claims(approved,{admin:true}));
  assert.equal(listed.ok,true,JSON.stringify(listed.body));
  assert.ok(listed.body.data.staffAccounts.some(p=>p.uid===pending));
  assert.ok(Object.hasOwn(listed.body.data.staffAccounts[0],'lastSignInAt'));
  assert.equal((await query('ListStaffDirectory',{offset:-1},claims(approved,{staff:true}))).ok,false);
});

test('real callable HTTP requests accept Google login, return pending, and reject privilege injection', async () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const identity = `${encode({alg:'none'})}.${encode({sub:randomUUID(),email:'callable@example.com',email_verified:true,name:'Callable User'})}.`;
  const loginResponse = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator-only',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      requestUri:'http://localhost',postBody:`providerId=google.com&id_token=${identity}`,returnSecureToken:true,
    }),
  });
  const login = await loginResponse.json();
  assert.ok(login.idToken,JSON.stringify(login));
  async function call(name,data,token=login.idToken) {
    const response = await fetch(`http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/${name}`,{
      method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
      body:JSON.stringify({data}),
    });
    return response.json();
  }
  const registered = await call('registerStaffSignIn',{});
  assert.ok(registered.result,JSON.stringify(registered));
  assert.equal(registered.result.isStaff,false);
  assert.equal(registered.result.isAdmin,false);
  assert.equal(registered.result.uid,login.localId);
  assert.match(registered.result.createdAt,/^\d{4}-\d\d-/);
  assert.match(registered.result.lastSignInAt,/^\d{4}-\d\d-/);
  assert.equal((await call('registerStaffSignIn',{isAdmin:true})).error.status,'INVALID_ARGUMENT');
  assert.equal((await call('registerStaffSignIn',{},null)).error.status,'UNAUTHENTICATED');
  assert.equal((await call('setStaffRoles',roles(login.localId,true,true))).error.status,'PERMISSION_DENIED');
  // Real admin call and token refresh prove that returned role state and issued
  // token claims are separate, and both flags survive the public callable path.
  const admin = await adminUser();
  const adminToken = unsigned({sub:admin,admin:true,firebase:{sign_in_provider:'google.com'}});
  const granted = await call('setStaffRoles',roles(login.localId,false,true),adminToken);
  assert.ok(granted.result,JSON.stringify(granted));
  assert.equal(granted.result.claimSyncStatus,'APPLIED');
  const oldClaims = JSON.parse(Buffer.from(login.idToken.split('.')[1],'base64url'));
  assert.notEqual(oldClaims.admin,true);
  const refresh = await fetch('http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=emulator-only',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',refresh_token:login.refreshToken}),
  });
  const refreshed = await refresh.json();
  assert.ok(refreshed.id_token,JSON.stringify(refreshed));
  const newClaims = JSON.parse(Buffer.from(refreshed.id_token.split('.')[1],'base64url'));
  assert.equal(newClaims.admin,true);
  assert.equal(newClaims.staff,false);
});
