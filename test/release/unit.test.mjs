import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {options,target,validateParameters,parseEnv,firebaseArgs,firebaseConfig,json,root,assertExports,loadManifest} from '../../scripts/release/config.mjs';
import {transactionBody} from '../../scripts/release/database.mjs';
import {cleanCommit} from '../../scripts/release/cli.mjs';
import {verifyCloud} from '../../scripts/release/cloud.mjs';

test('default target is dev and command always has explicit project/config',async()=>{
  const t=await target(options([]).environment);
  assert.equal(t.project,'mtl-service-e3e0c');
  assert.deepEqual(firebaseArgs(t,'config.json','deploy',['--only','functions:server']),['deploy','--project','mtl-service-e3e0c','--config','config.json','--only','functions:server']);
  const prod=await target(options(['--environment','production']).environment);assert.equal(prod.project,'mtl-service-production');assert.equal(prod.region,'northamerica-northeast2');assert.equal(prod.functionsRegion,'northamerica-northeast2');
  assert.throws(()=>options(['--project','production']));assert.throws(()=>options(['--environment','prod']));assert.throws(()=>options(['--config','evil.json']));
});
test('generated environment configurations share all sources and function settings',async()=>{
  const dev=await target('dev'),prod=await target('production');
  const d=await json(await firebaseConfig(dev)),p=await json(await firebaseConfig(prod));
  assert.deepEqual(d.functions,p.functions);assert.deepEqual(d.functions,(await json(join(root,'firebase.json'))).functions);
  const dy=await readFile(join(d.dataconnect.source,'dataconnect.yaml'),'utf8');
  const py=await readFile(join(p.dataconnect.source,'dataconnect.yaml'),'utf8');
  assert.equal(dy.replace(dev.instance,'INSTANCE').replace(dev.region,'REGION'),py.replace(prod.instance,'INSTANCE').replace(prod.region,'REGION'));
  assert.match(py,/schemaValidation: COMPATIBLE/);assert.match(py,/location: northamerica-northeast2/);
  const {readdir}=await import('node:fs/promises');
  for(const name of ['schema','staff-admin']) {
    const originals=(await readdir(join(root,'dataconnect',name))).filter(f=>/\.(gql|graphql)$/.test(f)||f==='connector.yaml').sort();
    assert.deepEqual((await readdir(join(p.dataconnect.source,name))).sort(),originals);
    for(const file of originals) assert.equal(await readFile(join(p.dataconnect.source,name,file),'utf8'),await readFile(join(root,'dataconnect',name,file),'utf8'));
  }
});
function parameters(t) {
  return Object.fromEntries(['STAFF','ORDERS'].flatMap(topic=>{
    const email=`mtl-${topic.toLowerCase()}-functions@${t.project}.iam.gserviceaccount.com`;
    return [[`${topic}_REGION`,t.functionsRegion],[`${topic}_SQL_INSTANCE`,t.connection],[`${topic}_SQL_DATABASE`,'restaurant'],[`${topic}_RUNTIME_SERVICE_ACCOUNT`,email],[`${topic}_SQL_USER`,email.replace('.gserviceaccount.com','')]];
  }));
}
test('cloud parameter validation rejects cross-project identities, local URLs, missing settings and shared identities',async()=>{
  const t=await target('production'),p=parameters(t);assert.deepEqual(validateParameters(t,p),p);
  for(const bad of [{...p,ORDERS_SQL_INSTANCE:(await target('dev')).connection},{...p,STAFF_RUNTIME_SERVICE_ACCOUNT:'staff@mtl-service-e3e0c.iam.gserviceaccount.com'},
    {...p,ORDERS_LOCAL_DATABASE_URL:'postgresql://127.0.0.1/db'},{...p,STAFF_SQL_DATABASE:undefined},{...p,STAFF_REGION:'northamerica-northeast1'},
    {...p,ORDERS_RUNTIME_SERVICE_ACCOUNT:p.STAFF_RUNTIME_SERVICE_ACCOUNT,ORDERS_SQL_USER:p.STAFF_SQL_USER}]) assert.throws(()=>validateParameters(t,bad));
  assert.throws(()=>parseEnv('KEY=a\nKEY=b'));assert.equal(parseEnv('# comment\nKEY="abc"').KEY,'abc');
});
test('production commit validation rejects tracked and untracked changes',async()=>{
  await assert.rejects(cleanCommit(async()=> '?? new-file'),/clean committed/);
  assert.equal(await cleanCommit(async(_cmd,args)=>args[0]==='status'?'':'abc123'),'abc123');
});
test('transactional native SQL is folded into one atomic ledger transaction',async()=>{
  const m=await json(join(root,'release/manifest.json'));
  for(const item of m.migrations.filter(migration=>migration.mode==="transaction")) assert.ok(transactionBody(await readFile(join(root,item.file),'utf8')).length);
  assert.throws(()=>transactionBody('CREATE TABLE x(id int);'));
  assert.throws(()=>transactionBody('BEGIN; SELECT 1; COMMIT; BEGIN; COMMIT;'));
});
test('manifest and export inventory match known server contracts',async()=>{
  const manifest=await loadManifest();assert.equal(manifest.migrations.length>=6,true);assert.equal(manifest.checksum.length,64);await assertExports();
});
test('read-only cloud verification checks deployed sources and rejects datasource drift',async()=>{
  const t=await target('dev');
  const {readdir}=await import('node:fs/promises');
  const files=await Promise.all((await readdir(join(root,'dataconnect/schema'))).filter(f=>f.endsWith('.gql')).map(async path=>({path,content:await readFile(join(root,'dataconnect/schema',path),'utf8')})));
  const resource={source:{files},datasources:[{postgresql:{database:'restaurant',schemaValidation:'COMPATIBLE',cloudSql:{instance:`projects/${t.project}/locations/${t.region}/instances/${t.instance}`}}}]};
  let calls=0;await verifyCloud(t,{},'schema',async url=>{calls++;assert.match(url,/^https:\/\/firebasedataconnect.googleapis.com\/v1\/projects\/mtl-service-e3e0c\//);return resource;});assert.equal(calls,1);
  await assert.rejects(verifyCloud(t,{},'schema',async()=>({...resource,datasources:[]})),/datasource/);
  await assert.rejects(verifyCloud(t,{},'schema',async()=>({...resource,source:{files:[]}})),/sources/);
});

test('fake Firebase executable sees dev even with production in ambient configuration',async()=>{
  const {firebase}=await import('../../scripts/release/cli.mjs');
  const oldCli=process.env.MTL_FIREBASE_CLI,oldProject=process.env.GCLOUD_PROJECT;
  try {
    process.env.MTL_FIREBASE_CLI=join(root,'test/release/fixtures/firebase.mjs');process.env.GCLOUD_PROJECT='mtl-service-production';
    await firebase(await target('dev'),'fake-config.json','deploy',['--only','functions:server']);
  } finally {
    if(oldCli===undefined)delete process.env.MTL_FIREBASE_CLI;else process.env.MTL_FIREBASE_CLI=oldCli;
    if(oldProject===undefined)delete process.env.GCLOUD_PROJECT;else process.env.GCLOUD_PROJECT=oldProject;
  }
});
test('manifest rejects duplicate IDs, unordered history, unsupported checks and destructive releases',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
  const directory=await mkdtemp(join(tmpdir(),'mtl-manifest-test-'));
  const base=await json(join(root,'release/manifest.json'));
  try {
    const variants=[{...base,version:2},{...base,components:['unknown']},{...base,checks:[]},
      {...base,migrations:[base.migrations[0],base.migrations[0]]},
      {...base,migrations:[base.migrations[1],base.migrations[0]]},
      {...base,migrations:[{...base.migrations[0],destructive:true}]},
      {...base,components:['schema'],schemaMaintenance:null}];
    for(const m of variants) {const path=join(directory,'manifest.json');await writeFile(path,JSON.stringify(m));await assert.rejects(loadManifest(path));}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('full cloud verification checks identities, scheduler and backups without fingerprinting scheduler execution timestamps',async()=>{
  const {functions:functionNames}=await import('../../scripts/release/config.mjs');
  const {readdir}=await import('node:fs/promises');
  const t=await target('production'),p=parameters(t);
  const files=async dir=>Promise.all((await readdir(join(root,dir))).filter(f=>f.endsWith('.gql')).map(async path=>({path,content:await readFile(join(root,dir,path),'utf8')})));
  const schema={source:{files:await files('dataconnect/schema')},datasources:[{postgresql:{database:'restaurant',schemaValidation:'COMPATIBLE',cloudSql:{instance:`projects/${t.project}/locations/${t.region}/instances/${t.instance}`}}}]};
  const connector={source:{files:await files('dataconnect/staff-admin')}};
  const functionResources=functionNames.map(name=>{
    const staff=['registerStaffSignIn','setStaffRoles','reconcileStaffRoles'].includes(name),topic=staff?'STAFF':'ORDERS';
    return {name:`projects/${t.project}/locations/${t.functionsRegion}/functions/${name}`,labels:{'firebase-functions-codebase':'server'},state:'ACTIVE',updateTime:'2026-11-16T00:00:00Z',buildConfig:{runtime:'nodejs22'},
      serviceConfig:{uri:`https://${name.toLowerCase()}-example.run.app`,serviceAccountEmail:p[`${topic}_RUNTIME_SERVICE_ACCOUNT`],maxInstanceCount:1,maxInstanceRequestConcurrency:2,timeoutSeconds:staff?120:60,
        environmentVariables:Object.fromEntries(['SQL_INSTANCE','SQL_USER','SQL_DATABASE','REGION'].map(suffix=>[`${topic}_${suffix}`,p[`${topic}_${suffix}`]]))}};
  });
  let attempts=0,schedulerTarget='https://reconcilestaffroles-example.run.app/';
  const instance={connectionName:t.connection,region:t.region,state:'RUNNABLE',databaseVersion:'POSTGRES_18',settings:{databaseFlags:[{name:'cloudsql.iam_authentication',value:'on'}],backupConfiguration:{enabled:true,pointInTimeRecoveryEnabled:true}}};
  const get=async url=>{
    if(url.endsWith('/schemas/main')){assert.ok(url.includes('/locations/northamerica-northeast2/'));return schema;}
    if(url.endsWith('/connectors/staff-admin'))return connector;
    if(url.endsWith('/functions')){assert.ok(url.includes('/locations/northamerica-northeast2/'));return {functions:functionResources};}
    if(url.includes('cloudscheduler'))return {name:'scheduler',state:'ENABLED',schedule:'every 1 minutes',lastAttemptTime:`run-${++attempts}`,httpTarget:{uri:schedulerTarget,httpMethod:'POST',oidcToken:{serviceAccountEmail:p.STAFF_RUNTIME_SERVICE_ACCOUNT}}};
    if(url.includes('sqladmin'))return instance;
    assert.fail(url);
  };
  const first=await verifyCloud(t,p,'all',get);assert.equal(await verifyCloud(t,p,'all',get),first);
  schedulerTarget=`https://${t.functionsRegion}-${t.project}.cloudfunctions.net/reconcileStaffRoles`;
  await verifyCloud(t,p,'all',get);
  schedulerTarget='https://attacker.example/reconcileStaffRoles';await assert.rejects(verifyCloud(t,p,'all',get),/scheduler differs/);
  schedulerTarget=`https://${t.functionsRegion}-${t.project}.cloudfunctions.net/reconcileStaffRoles`;
  instance.settings.backupConfiguration.pointInTimeRecoveryEnabled=false;
  await assert.rejects(verifyCloud(t,p,'all',get),/backups/);instance.settings.backupConfiguration.pointInTimeRecoveryEnabled=true;
  functionResources[0].serviceConfig.serviceAccountEmail='wrong@another-project.iam.gserviceaccount.com';
  await assert.rejects(verifyCloud(t,p,'all',get),/runtime mismatch/);
});

test('operator authentication defaults to ADC and rejects incomplete or unknown alternate modes',async()=>{
  const {operatorAuth}=await import('../../scripts/release/auth.mjs');
  const previous=process.env.MTL_RELEASE_AUTH,cli=process.env.MTL_FIREBASE_CLI;
  try {
    delete process.env.MTL_RELEASE_AUTH;assert.equal(typeof operatorAuth().request,'function');
    process.env.MTL_RELEASE_AUTH='unknown';assert.throws(()=>operatorAuth(),/Choose adc or firebase/);
    process.env.MTL_RELEASE_AUTH='firebase';delete process.env.MTL_FIREBASE_CLI;assert.throws(()=>operatorAuth(),/requires MTL_FIREBASE_CLI/);
  } finally {
    if(previous===undefined)delete process.env.MTL_RELEASE_AUTH;else process.env.MTL_RELEASE_AUTH=previous;
    if(cli===undefined)delete process.env.MTL_FIREBASE_CLI;else process.env.MTL_FIREBASE_CLI=cli;
  }
});
