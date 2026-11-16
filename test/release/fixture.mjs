import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from '../../scripts/release/database.mjs';
import {root,json} from '../../scripts/release/config.mjs';
import {policies} from '../../scripts/release/permissions.mjs';
export async function fixture() {
  if(process.env.GCLOUD_PROJECT!=='demo-mtl'||process.env.MTL_RELEASE_TEST_DATABASE_URL!=='postgresql://postgres:test-only@127.0.0.1:15433/restaurant?sslmode=disable') throw new Error('Release integration tests require isolated local runner');
  const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=`${encode({alg:'none'})}.${encode({sub:'release-test',aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
  if(process.env.MTL_RELEASE_TEST_SQL_REGION!=='northamerica-northeast2') throw new Error('Release test requires production SQL region');
  const response=await fetch(`http://127.0.0.1:9399/v1/projects/demo-mtl/locations/${process.env.MTL_RELEASE_TEST_SQL_REGION}/services/restaurant/connectors/staff-admin:executeQuery`,{method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName:'ListProducts',variables:{}})});
  const body=await response.json();if(!response.ok||body.errors?.length) throw new Error(JSON.stringify(body));
  const client=new Client({connectionString:process.env.MTL_RELEASE_TEST_DATABASE_URL});await client.connect();
  const manifest=await json(join(root,'release/manifest.json'));
  for(const migration of manifest.migrations.filter(x=>x.baselineOnly)) await client.query(await readFile(join(root,migration.file),'utf8'));
  return client;
}
export async function grantFixtures(client) {
  await client.query('CREATE ROLE release_staff; CREATE ROLE release_orders; CREATE ROLE firebasereader_release; CREATE ROLE firebasewriter_release; REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  for(const [topic,policy] of Object.entries(policies)) {
    const role=topic==='STAFF'?'release_staff':'release_orders';
    await client.query(`GRANT CONNECT ON DATABASE restaurant TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}`);
    for(const [privilege,tables] of [['SELECT',policy.select],['INSERT',policy.insert]]) for(const table of tables) await client.query(`GRANT ${privilege} ON public.${table} TO ${role}`);
    for(const [table,columns] of Object.entries(policy.update)) await client.query(`GRANT UPDATE${columns==='*'?'':`(${columns.join(',')})`} ON public.${table} TO ${role}`);
    for(const name of policy.execute) await client.query(`GRANT EXECUTE ON FUNCTION public.${name} TO ${role}`);
  }
}
export const parameters={STAFF_SQL_USER:'release_staff',ORDERS_SQL_USER:'release_orders'};
