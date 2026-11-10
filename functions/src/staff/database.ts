import {AuthTypes, Connector} from '@google-cloud/cloud-sql-connector';
import {defineString} from 'firebase-functions/params';
import {Pool} from 'pg';

const instance = defineString('STAFF_SQL_INSTANCE');
const user = defineString('STAFF_SQL_USER');
const database = defineString('STAFF_SQL_DATABASE', {default: 'restaurant'});
let pool: Promise<Pool> | undefined;
const connector = new Connector();

export function getPool(): Promise<Pool> {
  pool ??= createPool().catch(error => { pool = undefined; throw error; });
  return pool;
}

async function createPool(): Promise<Pool> {
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.STAFF_LOCAL_DATABASE_URL) {
    // This bypass is exclusively for local emulator runs and cannot select a cloud DB.
    const url = new URL(process.env.STAFF_LOCAL_DATABASE_URL);
    if (project !== 'demo-mtl' || !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')) {
      throw new Error('Local database requires demo-mtl, Auth emulator and a loopback host');
    }
    return new Pool({connectionString: url.toString(), max: 2, connectionTimeoutMillis: 10000});
  }
  if (process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_AUTH_EMULATOR_HOST || project?.startsWith('demo-')) {
    throw new Error('Emulator runs require STAFF_LOCAL_DATABASE_URL; cloud SQL is forbidden');
  }
  const options = await connector.getOptions({instanceConnectionName: instance.value(), authType: AuthTypes.IAM});
  return new Pool({...options, user: user.value(), database: database.value(), max: 2, connectionTimeoutMillis: 10000});
}

export async function closeDatabase(): Promise<void> {
  if (pool) await (await pool).end();
  connector.close();
}
