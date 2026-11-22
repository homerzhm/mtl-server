import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {SlipDatabase} from '../../lib/slips/database.js';
import {OrderSlipService} from '../../lib/slips/service.js';
import {RemoteFailure} from '../../lib/slips/transport.js';
import {id,productId,secondProductId,provider} from './fixtures.mjs';

const url=process.env.STAFF_LOCAL_DATABASE_URL;
if (process.env.GCLOUD_PROJECT!=='demo-mtl' ||
    url!=='postgresql://postgres:test-only@127.0.0.1:15432/restaurant?sslmode=disable') {
  throw new Error('Slip tests require the isolated demo-mtl emulator runner');
}
const pool=new pg.Pool({connectionString:url,max:4});
const database=new SlipDatabase(pool);
const photos=new Map(), dispatched=[], logs=[], models=[];
let nextGeneration=0, failEnqueue=true, failCleanup=false, failProvider=false;
let photo;
const businessTables=['client','customer_order','order_capacity_allocation','payment'];
const businessCounts=async()=>Promise.all(businessTables.map(async table=>
  (await pool.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n));
let beforeCounts;

const dependencies = {
  database,
  storage:{
    async save(key,bytes,checksum) {
      if(!photos.has(key)) photos.set(key,{bytes,checksum,generation:String(++nextGeneration)});
      const stored=photos.get(key);
      assert.equal(stored.checksum,checksum);
      return stored.generation;
    },
    async read(key,generation) {
      const stored=photos.get(key);
      if(stored?.generation!==generation) throw new RemoteFailure(404);
      return stored.bytes;
    },
    async remove(key,generation) {
      if(failCleanup) throw new Error('private storage payload');
      if(photos.get(key)?.generation===generation) photos.delete(key);
    },
  },
  enqueue:async task=>{
    if(failEnqueue) throw new Error('private queue payload');
    dispatched.push(task);
  },
  selection:()=>({provider:'deepseek',model:'deepseek-flash'}),
  provider:async selection=>{
    models.push(selection);
    if(failProvider) throw new RemoteFailure(429);
    return provider();
  },
  operationalLog:event=>logs.push(event),
};
const core = new OrderSlipService(dependencies);

before(async()=>{
  await pool.query(await readFile(new URL('../../../migrations/order-slip-tasks.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../../../migrations/order-slip-deepseek-provider.sql',import.meta.url),'utf8'));
  await pool.query(`INSERT INTO public.product(id,name,chinese_name,price_cents,is_active,revision,created_at)
    VALUES ($1,'Roast Pork 12 lb','燒豬',1000,true,0,now()),($2,'Roast Chicken',NULL,1000,true,0,now()),
      ($3,'Roast Chicken retired',NULL,1000,false,0,now())`,[productId,secondProductId,randomUUID()]);
  beforeCounts=await businessCounts();
  photo=(await sharp({create:{width:100,height:200,channels:3,background:'white'}}).jpeg().toBuffer()).toString('base64');
});
after(async()=>pool.end());

function authToken(uid, admin = true) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  return `${encode({alg:'none'})}.${encode({
    sub:uid, aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',
    iat:now,exp:now+3600,staff:true,admin,firebase:{sign_in_provider:'google.com'},
  })}.`;
}
function readTask(data,token) {
  return fetch('http://127.0.0.1:5001/demo-mtl/northamerica-northeast1/readOrderSlipTasks',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({data}),
  });
}
const message = row => ({taskId:row.id,generation:row.dispatch_generation});

test('recover upload after database interruption and deduplicate a lost enqueue',async()=>{
  const failingDatabase=new Proxy(database,{get(target,key) {
    if(key==='insert') return async()=>{throw new Error('private database payload');};
    return Reflect.get(target,key);
  }});
  // Use the service's normal storage and queue stub across both calls.
  const failing = new OrderSlipService({...dependencies,database:failingDatabase});
  await assert.rejects(failing.submit('admin-one',{requestId:id,photoBase64:photo}));
  assert.equal(photos.size,1);
  assert.equal(await database.find(id),undefined);
  const queued=await core.submit('admin-one',{requestId:id,photoBase64:photo});
  assert.equal(queued.status,'QUEUED');
  assert.deepEqual(await core.submit('admin-one',{requestId:id,photoBase64:photo}),queued);
  await assert.rejects(core.submit('admin-two',{requestId:id,photoBase64:photo}),{code:'already-exists'});
  const changed=(await sharp({create:{width:100,height:200,channels:3,background:'black'}}).jpeg().toBuffer()).toString('base64');
  await assert.rejects(core.submit('admin-one',{requestId:id,photoBase64:changed}),{code:'already-exists'});
  failEnqueue=false;
  await core.reconcile();
  assert.equal(dispatched.filter(task=>task.id===id).length,1);
});

test('status and preview are persisted and available to another Admin',async()=>{
  const task=await database.find(id);
  const duplicate=await Promise.all([core.process(message(task)),core.process(message(task))]);
  assert.equal(duplicate.length,2);
  assert.deepEqual(models,[{provider:'deepseek',model:'deepseek-flash'}]);
  const detail=await core.read({action:'get',taskId:id,includePhoto:true});
  assert.equal(detail.status,'READY');
  assert.equal(detail.preview.prefill.depositReceivedCents.value,2000);
  assert.equal(detail.preview.prefill.pickup.year.value,null);
  assert.equal((await sharp(Buffer.from(detail.photoBase64,'base64')).metadata()).format,'jpeg');
  const response=await readTask({action:'get',taskId:id},authToken('other-admin'));
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).result.preview.version,1);
  assert.equal((await readTask({action:'get',taskId:id},authToken('only-staff',false))).status,403);
  assert.equal((await database.catalog()).some(item=>item.name.includes('retired')),false);
  assert.deepEqual(await businessCounts(),beforeCounts);
});

test('leases fence stale workers, then retry exhaustion is persisted',async()=>{
  const taskId=randomUUID();
  await core.submit('admin-one',{requestId:taskId,photoBase64:photo});
  const first=await database.claim(await database.find(taskId));
  assert.equal((await core.read({action:'get',taskId})).status,'PROCESSING');
  await pool.query("UPDATE public.order_slip_task SET lease_until=now()-interval '1 second' WHERE id=$1",[taskId]);
  await core.reconcile();
  const second=await database.find(taskId);
  assert.equal(second.status,'QUEUED');
  assert.notEqual(second.dispatch_generation,first.dispatch_generation);
  await database.ready(first,{version:1});
  assert.equal((await database.find(taskId)).preview,null);
  failProvider=true;
  await core.process(message(second));
  await pool.query('UPDATE public.order_slip_task SET available_at=now() WHERE id=$1',[taskId]);
  await core.process(message(await database.find(taskId)));
  failProvider=false;
  const terminal=await core.read({action:'get',taskId});
  assert.equal(terminal.status,'FAILED');
  assert.equal(terminal.failureCode,'processing_unavailable');
  assert.equal(terminal.preview,null);
});

test('inbox pages stably and cleanup hides expired tasks before deleting their photo',async()=>{
  const seed=Array.from({length:26},()=>randomUUID()).sort();
  for(const key of seed) await database.insert(key,'admin-one','fixture-hash','fixture-photo','0',{provider:'vertex',model:'gemini-3.8-flash'});
  const first=await core.read({action:'list'});
  const second=await core.read({action:'list',cursor:first.nextCursor});
  assert.equal(first.tasks.length,25);
  assert.equal(new Set([...first.tasks,...second.tasks].map(task=>task.taskId)).size,28);
  const target=await database.find(id);
  await pool.query("UPDATE public.order_slip_task SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
  await assert.rejects(core.read({action:'get',taskId:id}),{code:'not-found'});
  failCleanup=true;
  await core.reconcile();
  assert.ok(await database.find(id,true));
  failCleanup=false;
  await core.reconcile();
  assert.equal(await database.find(id,true),undefined);
  assert.equal(photos.has(target.object_key),false);
  assert.ok(logs.every(event=>/^slip_[a-z_]+$/.test(event)));
});
