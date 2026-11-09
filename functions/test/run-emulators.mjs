import EmbeddedPostgres from 'embedded-postgres';
import {cp, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

// A real, disposable PostgreSQL server verifies row locks across independent
// connections. The default PGlite adapter serializes sessions and cannot do that.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'mtl-staff-tests-'));
const pg = new EmbeddedPostgres({databaseDir:join(directory,'pg'),user:'postgres',password:'test-only',
  port:15432,persistent:true,onLog:()=>{},onError:()=>{}});
let started = false;
try {
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase('restaurant');
  const url = 'postgresql://postgres:test-only@127.0.0.1:15432/restaurant?sslmode=disable';
  // Isolate Functions dotenv parameters from real developer/deployment settings.
  // Firebase's CLI parameter resolver reads dotenv files rather than shell values.
  const source = join(directory,'functions');
  await mkdir(source);
  await cp(join(root,'functions/lib'),join(source,'lib'),{recursive:true});
  await cp(join(root,'functions/package.json'),join(source,'package.json'));
  await symlink(join(root,'functions/node_modules'),join(source,'node_modules'),'dir');
  await writeFile(join(source,'.env.local'),[
    'STAFF_SQL_INSTANCE=unused-emulator','STAFF_SQL_USER=postgres','STAFF_SQL_DATABASE=restaurant',
    'STAFF_RUNTIME_SERVICE_ACCOUNT=staff-tests@demo-mtl.iam.gserviceaccount.com',
    `STAFF_LOCAL_DATABASE_URL=${url}`,
  ].join('\n'));
  const config = join(directory,'firebase.json');
  await writeFile(config,JSON.stringify({dataconnect:{source:join(root,'dataconnect')},
    functions:[{source:'functions',codebase:'server',runtime:'nodejs22'}],
    emulators:{auth:{port:9099},functions:{port:5001},dataconnect:{port:9399},ui:{enabled:false}}}));
  const env = {...process.env, GCLOUD_PROJECT:'demo-mtl', GOOGLE_CLOUD_PROJECT:'demo-mtl',
    FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099', STAFF_LOCAL_DATABASE_URL:url,
    FIREBASE_DATACONNECT_POSTGRESQL_STRING:url, STAFF_SQL_INSTANCE:'unused-emulator', STAFF_SQL_USER:'postgres',
    STAFF_RUNTIME_SERVICE_ACCOUNT:'staff-tests@demo-mtl.iam.gserviceaccount.com',
    CI:'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true'};
  // Optional CLI path lets developers use a current CLI with their native Node.
  const cli = process.env.MTL_FIREBASE_CLI;
  const args = ['emulators:exec','--config',config,'--only','auth,functions,dataconnect','--project','demo-mtl',
    'node --test --test-concurrency=1 functions/test/*/emulator.test.mjs tests/products.test.mjs tests/clients.test.mjs tests/orders.test.mjs'];
  const child = spawn(cli ? process.execPath : 'firebase', cli ? [resolve(cli), ...args] : args,
    {cwd:root,env,stdio:'inherit'});
  const code = await new Promise((resolve,reject) => {child.once('error',reject);child.once('exit',resolve);});
  if (code !== 0) process.exitCode = 1;
} finally {
  if (started) await pg.stop();
  await rm(directory,{recursive:true,force:true});
}
