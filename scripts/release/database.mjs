import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {root, safePath, digest, json, stableJson} from './config.mjs';
import {operatorAuth} from './auth.mjs';
const require = createRequire(`${root}/functions/package.json`);
export const {Client} = require('pg');

export async function connect(t) {
  const {Connector, AuthTypes} = require('@google-cloud/cloud-sql-connector');
  const user = process.env[`MTL_RELEASE_${t.name.toUpperCase()}_SQL_USER`];
  if (!user || user.includes('@') && !user.includes(t.project) && user.endsWith('.iam')) throw new Error('Set the environment-specific release operator SQL user');
  const connector = new Connector({auth:operatorAuth(t)});
  try {
    const config = await connector.getOptions({instanceConnectionName:t.connection, authType:AuthTypes.IAM});
    const client = new Client({...config,user,database:'restaurant',connectionTimeoutMillis:15000});
    await client.connect();
    const identity = await client.query('SELECT current_database() db, current_user actor');
    if (identity.rows[0].db !== 'restaurant') throw new Error('Wrong database');
    return {client,close:async()=>{await client.end(); connector.close();}};
  } catch (error) { connector.close(); throw error; }
}
export async function withLock(client, work) {
  const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('mtl-release',0)) locked");
  if (!result.rows[0].locked) throw new Error('Another release/verification is running');
  try { return await work(); }
  catch(error) {await client.query('ROLLBACK');throw error;}
  finally { await client.query("SELECT pg_advisory_unlock(hashtextextended('mtl-release',0))"); }
}
export async function assertEnvironment(client,t) {
  const result = await client.query('SELECT project_id FROM mtl_operations.environment WHERE singleton');
  if (result.rows[0]?.project_id !== t.project) throw new Error('Missing or wrong audited baseline; run release:baseline after provisioning');
}
export async function assertPrivateLedger(client, parameters) {
  const owner=(await client.query("SELECT pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname='mtl_operations'")).rows[0]?.owner;
  if (!owner) throw new Error('Operator must initialize release/operations.sql first');
  const roles=(await client.query(`SELECT rolname,rolsuper FROM pg_roles WHERE rolname<>$1 AND
    (rolname LIKE 'firebasereader_%' OR rolname LIKE 'firebasewriter_%' OR rolname IN ($2,$3))`,[owner,parameters.STAFF_SQL_USER,parameters.ORDERS_SQL_USER])).rows;
  for(const role of roles.filter(x=>!x.rolsuper)) {
    const access=await client.query(`SELECT has_schema_privilege($1,'mtl_operations','USAGE') OR has_schema_privilege($1,'mtl_operations','CREATE') OR
      EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='mtl_operations' AND
        (has_table_privilege($1,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
         has_any_column_privilege($1,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT,INSERT,UPDATE,REFERENCES'))) allowed`,[role.rolname]);
    if(access.rows[0].allowed) throw new Error(`Release metadata exposed to application role: ${role.rolname}`);
  }
  const publicAccess=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='mtl_operations' AND a.grantee=0) OR EXISTS(
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
    LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='mtl_operations' AND a.grantee=0) exposed`);
  if(publicAccess.rows[0].exposed) throw new Error('Release ledger grants PUBLIC access');
}
export async function migrationState(client, manifest) {
  const rows = (await client.query('SELECT id,checksum FROM mtl_operations.migration ORDER BY id')).rows;
  const expected = new Map(manifest.migrations.map(m=>[m.id,m]));
  for (const row of rows) {
    if (!expected.has(row.id) || row.checksum !== migrationChecksum(expected.get(row.id))) throw new Error(`Migration checksum drift or omitted history: ${row.id}`);
  }
  const applied = new Set(rows.map(r=>r.id));
  let gap = false;
  for(const item of manifest.migrations) {
    if(!applied.has(item.id)) gap=true;
    else if(gap) throw new Error('Migration history is out of order');
  }
  return manifest.migrations.filter(m=>!applied.has(m.id));
}
export const migrationChecksum = m=>digest(JSON.stringify([m.checksum,m.mode,m.procedureChecksum??null,m.verifyChecksum??null]));
export function transactionBody(sql) {
  // Existing native migrations own BEGIN/COMMIT. Fold that single outer pair into
  // the ledger transaction so DDL and successful migration recording commit together.
  const body=sql.replace(/^\s*--[^\n]*(?:\n|$)/gm,'').trim();
  if(!/^BEGIN\s*;/i.test(body) || !/COMMIT\s*;\s*$/i.test(body)) throw new Error('Transactional SQL must have one outer BEGIN/COMMIT');
  const inner=body.replace(/^BEGIN\s*;/i,'').replace(/COMMIT\s*;\s*$/i,'');
  // Blocks/functions contain BEGIN/END, but must never control transactions.
  if(/\b(?:COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i.test(inner)) throw new Error('Nested transaction control is forbidden');
  return inner;
}
async function readVerified(path,checksum) {
  const content=await readFile(safePath(path),'utf8');
  if(digest(content)!==checksum) throw new Error(`Release input changed during execution: ${path}`);
  return content;
}
export async function verifyMigration(client,item) {
  if(!item.verify) return;
  const sql=(await readVerified(item.verify,item.verifyChecksum)).trim().replace(/;$/, '');
  if(!/^SELECT\b/i.test(sql)||sql.includes(';')) throw new Error('Migration verification must be one SELECT statement');
  const result=await client.query(sql);
  if(result.rows?.length!==1 || result.rows[0].ok!==true) throw new Error(`Migration verification failed: ${item.id}`);
}
export async function applyMigrations(client,manifest,commit,context={}) {
  const pending=await migrationState(client,manifest);
  if(pending.some(m=>m.baselineOnly)) throw new Error('Initial native migrations require audited provisioning/baseline; not a routine release');
  for(const m of pending) {
    if(m.mode==='transaction') {
      await client.query('BEGIN');
      try {
        await client.query(transactionBody(await readVerified(m.file,m.checksum)));
        await verifyMigration(client,m);
        await client.query('INSERT INTO mtl_operations.migration(id,checksum,commit_sha) VALUES($1,$2,$3)',[m.id,migrationChecksum(m),commit]);
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK'); throw error;}
    } else {
      // The reviewed idempotent module owns its transactions and resumes its own
      // interrupted maintenance. Never pretend a failed external stage rolled back.
      await readVerified(m.file,m.checksum);
      if(m.procedure) await readVerified(m.procedure,m.procedureChecksum);
      const {up}=await import(pathToFileURL(safePath(m.file)).href);
      if(typeof up!=='function') throw new Error('Maintenance module must export up(client, context)');
      await up(client,context);
      await verifyMigration(client,m);
      await client.query('INSERT INTO mtl_operations.migration(id,checksum,commit_sha) VALUES($1,$2,$3)',[m.id,migrationChecksum(m),commit]);
    }
  }
}
export async function releaseRow(client,commit,manifest) {
  return (await client.query('SELECT * FROM mtl_operations.release WHERE commit_sha=$1 AND manifest_checksum=$2',[commit,manifest.checksum])).rows[0];
}
export async function startRelease(client,commit,m) {
  await client.query(`INSERT INTO mtl_operations.release(commit_sha,manifest_checksum,migration_checksum,state)
    VALUES($1,$2,$3,'deploying') ON CONFLICT(commit_sha,manifest_checksum) DO UPDATE SET state='deploying',
    verified_at=NULL,accepted_by=NULL,resource_fingerprint=NULL,updated_at=clock_timestamp()`,[commit,m.checksum,m.migrationHash]);
}
export async function saveStage(client,commit,m,name,fingerprint) {
  await client.query(`UPDATE mtl_operations.release SET stages=stages || jsonb_build_object($3::text,$4::text),updated_at=clock_timestamp()
    WHERE commit_sha=$1 AND manifest_checksum=$2`,[commit,m.checksum,name,fingerprint]);
}
export async function markState(client,commit,m,state,fingerprint=null) {
  await client.query(`UPDATE mtl_operations.release SET state=$3,resource_fingerprint=$4,updated_at=clock_timestamp()
    WHERE commit_sha=$1 AND manifest_checksum=$2`,[commit,m.checksum,state,fingerprint]);
}
export async function assertPromotable(client,commit,m,fingerprint) {
  const row=await releaseRow(client,commit,m);
  const latest=(await client.query('SELECT commit_sha,manifest_checksum FROM mtl_operations.release ORDER BY updated_at DESC LIMIT 1')).rows[0];
  if(row?.state!=='verified' || row.migration_checksum!==m.migrationHash || row.resource_fingerprint!==fingerprint || latest?.commit_sha!==commit || latest?.manifest_checksum!==m.checksum) throw new Error('Production requires the current verified dev release with unchanged deployed resources');
  if((await migrationState(client,m)).length) throw new Error('Dev migrations are incomplete');
}
export async function assertEmpty(client) {
  const tables=['product','client','capacity_group','customer_order','order_item','payment','refund','order_audit_event','order_capacity_allocation','order_creation_request','order_action_request','native_order_edit_context'];
  for(const table of tables) if((await client.query(`SELECT EXISTS(SELECT 1 FROM public.${table}) populated`)).rows[0].populated) throw new Error(`Expected empty business table: ${table}`);
}

// Stable catalog inventory also serves the cleanup report and reviewed contract.
export async function inventory(client) {
  const queries={
    columns:`SELECT c.table_name,c.column_name,c.data_type,c.udt_name,c.is_nullable,c.column_default FROM information_schema.columns c WHERE table_schema='public' ORDER BY table_name,ordinal_position`,
    constraints:`SELECT c.conrelid::regclass::text AS table_name,c.conname AS name,c.contype,pg_get_constraintdef(c.oid) definition,c.convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY 1,2`,
    indexes:`SELECT tablename AS table_name,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2`,
    triggers:`SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2`,
    routines:`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) args,p.prosecdef security_definer,p.proconfig config,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY 1,2`,
  };
  const result={};
  for(const [name,sql] of Object.entries(queries)) result[name]=(await client.query(sql)).rows;
  return result;
}
export async function verifyContract(client,manifest) {
  const expected=await json(safePath(manifest.databaseContract));
  const actual=await inventory(client);
  for(const [section,rows] of Object.entries(expected)) {
    if(!Array.isArray(actual[section])) throw new Error('Invalid database contract');
    for(const row of rows) {
      // Compare semantic object definitions, not OIDs or environment-specific owners.
      const {equivalentDefinitions,...definition}=row;
      if(equivalentDefinitions && (section!=='constraints'||row.contype!=='c'||!Array.isArray(equivalentDefinitions)||equivalentDefinitions.some(value=>typeof value!=='string'))) throw new Error('Equivalent definitions are only allowed for reviewed CHECK formatting');
      const candidates=[definition,...(equivalentDefinitions??[]).map(value=>({...definition,definition:value}))];
      if(!actual[section].some(value=>candidates.some(candidate=>stableJson(value)===stableJson(candidate)))) throw new Error(`Database contract mismatch: ${section} ${row.table_name??''}.${row.name??row.column_name??''}`);
    }
  }
  if(actual.columns.some(row=>row.column_default==='uuid_generate_v4()')) {
    const generator=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid
      WHERE n.nspname='public' AND p.proname='uuid_generate_v4' AND p.pronargs=0 AND e.extname='uuid-ossp' AND p.prosrc='uuid_generate_v4' AND p.probin='$libdir/uuid-ossp') ok`);
    if(!generator.rows[0]?.ok) throw new Error('UUID default must use the genuine uuid-ossp v4 generator');
  }
  if(Object.keys(expected).length!==5 || !expected.routines?.length || !expected.triggers?.length) throw new Error('Incomplete database contract');
  return digest(JSON.stringify(actual));
}
