import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {root, options, target, loadManifest, readParameters, firebaseConfig, firebaseArgs, assertExports, functions as functionNames, slipFunctions} from './config.mjs';
import {connect, withLock, assertEnvironment, assertPrivateLedger, applyMigrations, migrationState, migrationChecksum, startRelease, saveStage, markState, releaseRow, assertPromotable, assertEmpty, inventory, verifyContract} from './database.mjs';
import {verifyPermissions} from './permissions.mjs';
import {verifyCloud} from './cloud.mjs';

export async function run(executable,args,{capture=false,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,env,stdio:capture?['ignore','pipe','pipe']:'inherit'});
    let stdout='',stderr='';
    if(capture){child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);}
    const interrupt=signal=>child.kill(signal);
    const onInterrupt=()=>interrupt('SIGINT'),onTerminate=()=>interrupt('SIGTERM');
    const cleanup=()=>{process.off('SIGINT',onInterrupt);process.off('SIGTERM',onTerminate);};
    process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',code=>{cleanup();code===0?resolve(stdout.trim()):reject(new Error(`${executable} ${args[0]} failed (${code})${capture?`: ${stderr.trim()}`:''}`));});
  });
}
export async function cleanCommit(execute=run) {
  if(await execute('git',['status','--porcelain','--untracked-files=normal'],{capture:true})) throw new Error('Release requires a clean committed checkout (including untracked files)');
  return execute('git',['rev-parse','HEAD'],{capture:true});
}
export async function firebase(t,config,command,args=[]) {
  const argv=firebaseArgs(t,config,command,args);
  if(process.env.MTL_FIREBASE_CLI) return run(process.execPath,[process.env.MTL_FIREBASE_CLI,...argv]);
  return run('firebase',argv);
}
export async function localChecks(manifest) {
  const cli=process.env.MTL_FIREBASE_CLI;
  await run('npm',['--prefix','functions','ci']);
  const checks={
    'release-unit':()=>run(process.execPath,['--test','test/release/unit.test.mjs']),
    'release-integration':()=>run(process.execPath,['scripts/release/test-integration.mjs']),
    schema:()=>cli?run(process.execPath,[cli,'emulators:exec','--only','dataconnect','--project','demo-mtl','--config',join(root,'firebase.json'),'true']):run('firebase',['emulators:exec','--only','dataconnect','--project','demo-mtl','--config',join(root,'firebase.json'),'true']),
    'functions-unit':()=>run('npm',['--prefix','functions','test']),
    emulators:()=>run('npm',['--prefix','functions','run','test:emulators']),
  };
  for(const check of manifest.checks) {console.log(`Verification: ${check}`);await checks[check]();}
}
async function databaseChecks(client,m,parameters) {
  const contract=await verifyContract(client,m);
  await verifyPermissions(client,parameters);
  await assertPrivateLedger(client,parameters);
  const connections=(await client.query('SHOW max_connections')).rows[0].max_connections;
  const pooledConnections=(functionNames.length-slipFunctions.length)*2+slipFunctions.length;
  if(Number(connections)-3<pooledConnections) throw new Error(`Insufficient database connection budget (${pooledConnections} pooled + 3 reserved)`);
  return contract;
}
export async function componentStage({client,commit,manifest,name,deploy,verify}) {
  const previous=(await releaseRow(client,commit,manifest))?.stages?.[name];
  if(previous) {
    if(await verify()!==previous) throw new Error(`Completed ${name} stage drifted; investigate before resuming`);
    console.log(`Already completed: ${name}`);return;
  }
  await deploy();
  const fingerprint=await verify();
  await saveStage(client,commit,manifest,name,fingerprint);
}
async function baseline(client,t,m,commit,parameters,expectEmpty) {
  if((await client.query('SELECT count(*)::int n FROM mtl_operations.environment')).rows[0].n) throw new Error('Baseline already exists; use normal releases');
  if(t.name==='production'&&!expectEmpty) throw new Error('Initial production baseline requires --expect-empty');
  await databaseChecks(client,m,parameters);
  await verifyCloud(t,parameters);
  if(expectEmpty) await assertEmpty(client);
  if(m.migrations.some(x=>!x.baselineOnly)) throw new Error('Baseline requires a manifest containing only audited initial migrations');
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO mtl_operations.environment(project_id) VALUES($1)',[t.project]);
    for(const item of m.migrations) await client.query('INSERT INTO mtl_operations.migration(id,checksum,commit_sha) VALUES($1,$2,$3)',[item.id,migrationChecksum(item),commit]);
    await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK');throw error;}
  console.log('Audited baseline recorded. Deploy this commit before dev acceptance; baseline is not a code deployment.');
}
async function validateComponentChanges(client,commit,m) {
  const last=(await client.query("SELECT commit_sha FROM mtl_operations.release WHERE state IN ('deployed','verified') ORDER BY updated_at DESC LIMIT 1")).rows[0];
  if(!last) {
    if(!m.components.includes('functions')||!m.components.includes('connector')) throw new Error('First managed release must deploy Functions and connector');
    return;
  }
  const changed=(await run('git',['diff','--name-only',last.commit_sha,commit],{capture:true})).split('\n');
  for(const [prefix,component] of [['functions/','functions'],['dataconnect/staff-admin/','connector'],['dataconnect/schema/','schema']]) {
    if(changed.some(p=>p.startsWith(prefix))&&!m.components.includes(component)) throw new Error(`Changed ${prefix} requires ${component} in the manifest`);
  }
}
export async function main(args=process.argv.slice(2)) {
  const [command,...rest]=args;
  if(!['deploy','verify','baseline','audit','configure'].includes(command)) throw new Error('Choose deploy, verify, baseline, audit, or configure');
  const opts=options(rest),t=await target(opts.environment),m=await loadManifest();
  if(opts['accept-dev']&&(command!=='verify'||t.name!=='dev')) throw new Error('--accept-dev is only for dev verification');
  if(opts['expect-empty']&&!['baseline','audit'].includes(command)) throw new Error('--expect-empty is only for baseline/audit');
  if(command==='verify'&&(t.name!=='dev'||!opts['accept-dev'])) throw new Error('Dev acceptance requires release:verify -- --accept-dev');
  await assertExports();
  if(command==='configure') {
    if(opts['dry-run']) throw new Error('configure is local-only; omit --dry-run');
    await readParameters(t);
    console.log(await firebaseConfig(t));return;
  }
  const commit=opts['dry-run']?await run('git',['rev-parse','HEAD'],{capture:true}):await cleanCommit();
  console.log(JSON.stringify({command,environment:t.name,project:t.project,instance:t.connection,sqlRegion:t.region,functionsRegion:t.functionsRegion,commit,manifest:m.checksum,components:m.components,migrations:m.migrations.map(x=>({id:x.id,mode:x.mode,checksum:migrationChecksum(x)}))},null,2));
  if(opts['dry-run']) {console.log('Preview only: no cloud connection or deployment. Runtime parameters and remote baseline are checked during execution.');return;}
  if(Object.keys(process.env).some(k=>k.includes('EMULATOR')||k==='FIREBASE_DATACONNECT_POSTGRESQL_STRING')) throw new Error('Release commands cannot run with emulator overrides');
  const parameters=await readParameters(t);
  if(command==='verify') {await localChecks(m);if(await cleanCommit()!==commit) throw new Error('Checkout changed during verification');}
  const config=await firebaseConfig(t);
  // Always acquire dev before production so concurrent promotion/verification has
  // one lock ordering. Hold dev stable until the production release completes.
  let devConnection,connection;
  try {
    if(command==='deploy'&&t.name==='production') devConnection=await connect(await target('dev'));
    connection=await connect(t);
    const work=async()=>withLock(connection.client,async()=>{
      const client=connection.client;
      if(command==='baseline') return baseline(client,t,m,commit,parameters,opts['expect-empty']);
      if(command==='audit') {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const report=await inventory(client);
        report.grants=(await client.query("SELECT grantee,table_schema,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema IN ('public','mtl_operations') ORDER BY 1,2,3,4")).rows;
        report.columnGrants=(await client.query("SELECT grantee,table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE table_schema='public' ORDER BY 1,2,3,4")).rows;
        report.routineGrants=(await client.query("SELECT grantee,routine_name,privilege_type FROM information_schema.routine_privileges WHERE routine_schema='public' ORDER BY 1,2,3")).rows;
        report.dependencies=(await client.query(`SELECT pg_describe_object(d.classid,d.objid,d.objsubid) dependent, pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) referenced,d.deptype
          FROM pg_depend d JOIN pg_class c ON d.refclassid='pg_class'::regclass AND d.refobjid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' ORDER BY 1,2,3`)).rows;
        if(opts['expect-empty']) await assertEmpty(client);
        await client.query('COMMIT');
        console.log(JSON.stringify(report,null,2));return;
      }
      await assertEnvironment(client,t);
      await assertPrivateLedger(client,parameters);
      if(command==='verify') {
        if((await releaseRow(client,commit,m))?.state!=='deployed') throw new Error('Deploy this exact release to dev before verification');
        if((await migrationState(client,m)).length) throw new Error('Pending migrations');
        await databaseChecks(client,m,parameters);
        const fingerprint=await verifyCloud(t,parameters);
        const row=await releaseRow(client,commit,m);
        if(row.resource_fingerprint!==fingerprint) throw new Error('Deployed resources changed since deployment');
        const latest=(await client.query('SELECT commit_sha,manifest_checksum FROM mtl_operations.release ORDER BY updated_at DESC LIMIT 1')).rows[0];
        if(latest.commit_sha!==commit||latest.manifest_checksum!==m.checksum) throw new Error('A newer release exists');
        if(await cleanCommit()!==commit) throw new Error('Checkout changed during verification');
        await client.query(`UPDATE mtl_operations.release SET state='verified',accepted_by=current_user,verified_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE commit_sha=$1 AND manifest_checksum=$2`,[commit,m.checksum]);
        console.log(`Dev verified and operator acceptance recorded: ${commit}`);return;
      }
      if(devConnection) {
        const dev=await target('dev'),p=await readParameters(dev);
        await assertEnvironment(devConnection.client,dev);
        await databaseChecks(devConnection.client,m,p);
        await assertPromotable(devConnection.client,commit,m,await verifyCloud(dev,p));
      }
      await validateComponentChanges(client,commit,m);
      if(!m.components.includes('schema')) await verifyCloud(t,parameters,'schema');
      await startRelease(client,commit,m);
      try {
        const context={target:t,config,parameters,firebase:(cmd,args)=>firebase(t,config,cmd,args)};
        if(await cleanCommit()!==commit) throw new Error('Checkout changed before migrations');
        await applyMigrations(client,m,commit,context);
        await databaseChecks(client,m,parameters);
        for(const name of ['connector','functions'].filter(c=>m.components.includes(c))) {
          await componentStage({client,commit,manifest:m,name,
            deploy:async()=>{
              if(await cleanCommit()!==commit) throw new Error('Checkout changed before component deployment');
              await firebase(t,config,'deploy',['--only',name==='connector'?'dataconnect:restaurant:staff-admin':'functions:server','--non-interactive']);
            },
            verify:()=>verifyCloud(t,parameters,name)});
        }
        const fingerprint=await verifyCloud(t,parameters);
        if(await cleanCommit()!==commit) throw new Error('Checkout changed during deployment; release not accepted');
        await markState(client,commit,m,'deployed',fingerprint);
        console.log(`${t.name} deployed: ${commit}${t.name==='dev'?'. Verify business behavior, then run npm run release:verify -- --accept-dev.':''}`);
      } catch(error){await markState(client,commit,m,'failed');throw error;}
    });
    if(devConnection) await withLock(devConnection.client,work);else await work();
  } finally {
    if(connection) await connection.close();
    if(devConnection) await devConnection.close();
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) main().catch(error=>{console.error(error.message);process.exitCode=1;});
