import {readFile, readdir, mkdir, writeFile, rm, copyFile} from 'node:fs/promises';
import {resolve, relative, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const region = 'northamerica-northeast1';
export const functions = ['registerStaffSignIn','setStaffRoles','reconcileStaffRoles','createStaffOrder','updateStaffOrder','manageBookingConfiguration','getBookingAvailability','manageReportEntries','importHistoricalOrder'];
export const checkNames = ['release-unit','release-integration','schema','functions-unit','emulators'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export const stableJson = value => JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
export const json = async path => JSON.parse(await readFile(path, 'utf8'));
export function options(args) {
  const {values, positionals} = parseArgs({args, allowPositionals:true, options:{
    environment:{type:'string',default:'dev'}, 'dry-run':{type:'boolean',default:false},
    'accept-dev':{type:'boolean',default:false}, 'expect-empty':{type:'boolean',default:false},
  }});
  if (positionals.length) throw new Error('Unexpected positional arguments');
  if (!['dev','production'].includes(values.environment)) throw new Error('Unknown environment');
  return values;
}
export async function target(name) {
  const environments = await json(join(root,'release/environments.json'));
  const t = environments[name];
  if (!t || t.project !== (name === 'dev' ? 'mtl-service-e3e0c' : 'mtl-service-production') || !/^[a-z][a-z0-9-]+$/.test(t.instance) || !['northamerica-northeast1','northamerica-northeast2'].includes(t.region) || !['northamerica-northeast1','northamerica-northeast2'].includes(t.functionsRegion)) throw new Error('Invalid environment mapping');
  return {...t, name, connection:`${t.project}:${t.region}:${t.instance}`};
}
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\')) throw new Error('Invalid repository path');
  const absolute = resolve(root,path);
  if ((relative(root,absolute)==='..' || relative(root,absolute).startsWith(`..${sep}`)) || absolute === resolve(root) || path.startsWith('/')) throw new Error('Path must remain inside repository');
  return absolute;
}
export async function loadManifest(manifestPath=join(root,'release/manifest.json')) {
  const raw = await readFile(manifestPath,'utf8');
  const m = JSON.parse(raw);
  if (m.version !== 1 || !Array.isArray(m.components) || !m.components.length ||
      new Set(m.components).size !== m.components.length || m.components.some(c=>!['connector','functions','schema'].includes(c)) ||
      !Array.isArray(m.migrations) || JSON.stringify(m.checks) !== JSON.stringify(checkNames)) throw new Error('Invalid release manifest');
  if (m.components.includes('schema') !== Boolean(m.schemaMaintenance)) throw new Error('Schema releases require reviewed maintenance');
  const ids = new Set(), files = new Set();
  const hashFile = async path => digest(await readFile(safePath(path)));
  for (const item of m.migrations) {
    if (!/^[0-9]{3}-[a-z0-9-]+$/.test(item.id) || ids.has(item.id) || files.has(item.file) || !['transaction','maintenance'].includes(item.mode)) throw new Error('Invalid or duplicate migration');
    if (ids.size && item.id <= [...ids].at(-1)) throw new Error('Migrations must be ordered');
    if (item.destructive) throw new Error(`Destructive migration requires separate review: ${item.id}`);
    if (item.mode === 'maintenance' && (!item.procedure || item.idempotent !== true)) throw new Error('Maintenance requires an idempotent reviewed procedure');
    if (item.mode === 'maintenance' && !item.file.endsWith('.mjs')) throw new Error('Maintenance migrations must be ES modules');
    if (item.mode === 'transaction' && !item.file.endsWith('.sql')) throw new Error('Transactional migrations must be SQL');
    ids.add(item.id); files.add(item.file); item.checksum = await hashFile(item.file);
    if (item.procedure) item.procedureChecksum = await hashFile(item.procedure);
    if (!item.baselineOnly && !item.verify) throw new Error('New migrations require a verification SQL file');
    if (item.verify) item.verifyChecksum = await hashFile(item.verify);
  }
  if (m.schemaMaintenance && !m.migrations.some(x=>x.id === m.schemaMaintenance && x.mode === 'maintenance')) throw new Error('Schema maintenance must identify a migration');
  const migrationHash = digest(JSON.stringify(m.migrations));
  const contractHash = await hashFile(m.databaseContract);
  return {...m, checksum:digest(raw + migrationHash + contractHash), migrationHash};
}
export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || Object.hasOwn(result,match[1])) throw new Error('Invalid or duplicate dotenv setting');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
    result[match[1]] = value;
  }
  return result;
}
export function validateParameters(t, parameters) {
  const allowed = ['STAFF','ORDERS','REPORT'].flatMap(topic=>['SQL_INSTANCE','SQL_USER','SQL_DATABASE','RUNTIME_SERVICE_ACCOUNT','REGION'].map(k=>`${topic}_${k}`));
  if (Object.keys(parameters).some(key=>!allowed.includes(key))) throw new Error('Unexpected cloud parameter (emulator/credential settings are forbidden)');
  for (const topic of ['STAFF','ORDERS','REPORT']) {
    const email = parameters[`${topic}_RUNTIME_SERVICE_ACCOUNT`];
    if (!email || !new RegExp(`^[a-z][a-z0-9-]*@${t.project}\\.iam\\.gserviceaccount\\.com$`).test(email) ||
        parameters[`${topic}_REGION`] !== t.functionsRegion || parameters[`${topic}_SQL_INSTANCE`] !== t.connection || parameters[`${topic}_SQL_DATABASE`] !== 'restaurant' ||
        parameters[`${topic}_SQL_USER`] !== email.replace('.gserviceaccount.com','')) throw new Error(`${topic} parameters do not match ${t.project}`);
  }
  const identities = ['STAFF','ORDERS','REPORT'].map(topic=>parameters[`${topic}_RUNTIME_SERVICE_ACCOUNT`]);
  if (new Set(identities).size !== identities.length) throw new Error('Staff, Orders and Report require separate identities');
  return parameters;
}
export async function readParameters(t) {
  const names = await readdir(join(root,'functions'));
  // Firebase merges generic and alias dotenv files; forbid ambiguous sources.
  for (const name of ['.env',`.env.${t.name}`,'.env.default']) if (names.includes(name)) throw new Error(`Remove ambiguous Functions configuration: ${name}`);
  return validateParameters(t,parseEnv(await readFile(join(root,`functions/.env.${t.project}`),'utf8')));
}
export async function firebaseConfig(t) {
  const base = await json(join(root,'firebase.json'));
  const original = await readFile(join(root,'dataconnect/dataconnect.yaml'),'utf8');
  if (!original.includes('schemaValidation: COMPATIBLE') || !original.includes(`location: ${region}`) || !original.includes('serviceId: restaurant')) throw new Error('Unexpected shared SQL Connect configuration');
  const directory = join(root,'.firebase/releases',`${t.name}-${process.pid}`);
  await mkdir(directory,{recursive:true});
  // SQL Connect's compiler restricts reads to its service directory, including
  // symlinks. Generate disposable snapshots from the single maintained sources.
  for(const name of ['schema','staff-admin']) {
    const destination=join(directory,name),source=join(root,'dataconnect',name);
    await rm(destination,{recursive:true,force:true});
    await mkdir(destination,{recursive:true});
    for(const file of await readdir(source)) {
      if(/\.(gql|graphql)$/.test(file)||file==='connector.yaml') await copyFile(join(source,file),join(destination,file));
    }
  }
  const yaml = original.replace(/instanceId: [^\n]+/,`instanceId: ${t.instance}`).replace(/location: [^\n]+/,`location: ${t.region}`);
  await writeFile(join(directory,'dataconnect.yaml'),yaml);
  const config = join(root,`.firebase-release-${t.name}-${process.pid}.json`);
  await writeFile(config,JSON.stringify({...base, dataconnect:{source:directory}},null,2)+'\n');
  return config;
}
export function firebaseArgs(t, config, command, args=[]) {
  return [command,'--project',t.project,'--config',config,...args];
}
export async function assertExports() {
  const index = await readFile(join(root,'functions/src/index.ts'),'utf8');
  const names = [...index.matchAll(/export\s*\{([^}]+)\}/g)].flatMap(m=>m[1].split(',').map(x=>x.trim()));
  if (JSON.stringify(names.sort()) !== JSON.stringify([...functions].sort())) throw new Error('Function export inventory changed; review release tooling and connection budget');
}
