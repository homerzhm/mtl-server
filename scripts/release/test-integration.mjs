import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root,target,firebaseConfig,json} from './config.mjs';
import {run} from './cli.mjs';
const require=createRequire(`${root}/functions/package.json`);
const EmbeddedPostgres=require('embedded-postgres').default;
const directory=await mkdtemp(join(tmpdir(),'mtl-release-tests-'));
const port=15433;
const pg=new EmbeddedPostgres({databaseDir:join(directory,'pg'),user:'postgres',password:'test-only',port,persistent:true,onLog:()=>{},onError:()=>{}});
let started=false;
try {
  await pg.initialise();await pg.start();started=true;await pg.createDatabase('restaurant');
  const url=`postgresql://postgres:test-only@127.0.0.1:${port}/restaurant?sslmode=disable`;
  const config=join(directory,'firebase.json');
  // Exercise the actual generated production mapping against loopback/demo-mtl,
  // proving both environments compile the same shared sources without cloud access.
  const generated=await json(await firebaseConfig(await target('production')));
  await writeFile(config,JSON.stringify({dataconnect:generated.dataconnect,emulators:{dataconnect:{port:9399},ui:{enabled:false}}}));
  const capture=process.argv.includes('--write-contract');
  const command=capture?'node scripts/release/capture-contract.mjs':'node --test --test-concurrency=1 test/release/integration.test.mjs';
  const args=['emulators:exec','--project','demo-mtl','--config',config,'--only','dataconnect',command];
  const env={...process.env,GCLOUD_PROJECT:'demo-mtl',GOOGLE_CLOUD_PROJECT:'demo-mtl',FIREBASE_DATACONNECT_POSTGRESQL_STRING:url,
    MTL_RELEASE_TEST_DATABASE_URL:url,CI:'true',FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true'};
  await run(process.env.MTL_FIREBASE_CLI?process.execPath:'firebase',process.env.MTL_FIREBASE_CLI?[process.env.MTL_FIREBASE_CLI,...args]:args,{env});
} finally {
  if(started) await pg.stop();
  await rm(directory,{recursive:true,force:true});
}
