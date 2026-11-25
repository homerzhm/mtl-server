import {AuthTypes, Connector} from '@google-cloud/cloud-sql-connector';
import {randomInt, randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {isEmulator, slipsDatabase, slipsInstance, slipsUser} from './config';
import {ModelSelection} from './model';
import {CatalogProduct, OrderSlipPreview} from './preview';

export type FailureCode = 'photo_unavailable' | 'invalid_preview' | 'processing_unavailable';
export type SlipTask = {
  id: string; actor_uid: string; checksum: string; object_key: string; object_generation: string;
  provider: ModelSelection['provider']; model: string; status: 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED';
  preview: OrderSlipPreview | null; failure_code: FailureCode | null;
  created_at: Date; updated_at: Date; expires_at: Date;
  dispatch_generation: number; lease_token: string | null;
};
export type Dispatch = {id: string; dispatch_generation: number};
type Cursor = {time: string; id: string};
let pool: Promise<Pool> | undefined;

async function openPool() {
  if (isEmulator()) {
    const url = new URL(process.env.SLIPS_LOCAL_DATABASE_URL ?? '');
    const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (project !== 'demo-mtl' || !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
        !['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')) {
      throw new Error('Slip emulator requires a disposable loopback database');
    }
    return new Pool({connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000});
  }
  const connector = new Connector();
  try {
    const options = await connector.getOptions({instanceConnectionName: slipsInstance.value(), authType: AuthTypes.IAM});
    return new Pool({...options, user: slipsUser.value(), database: slipsDatabase.value(),
      max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000});
  } catch (error) {
    connector.close();
    throw error;
  }
}

export async function slipDatabase() {
  pool ??= openPool().catch(error => { pool = undefined; throw error; });
  return new SlipDatabase(await pool);
}

export class SlipDatabase {
  constructor(private readonly pool: Pool) {}

  async find(id: string, includeExpired = false): Promise<SlipTask | undefined> {
    const {rows} = await this.pool.query<SlipTask>(
      'SELECT * FROM public.order_slip_task WHERE id=$1 AND ($2 OR expires_at > now())', [id, includeExpired]);
    return rows[0];
  }

  async insert(id: string, actorUid: string, checksum: string, objectKey: string, objectGeneration: string,
    model: ModelSelection): Promise<SlipTask> {
    await this.pool.query(`
      INSERT INTO public.order_slip_task
        (id,actor_uid,checksum,object_key,object_generation,provider,model,status,
         created_at,updated_at,expires_at,available_at,dispatch_generation,attempts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'QUEUED',date_trunc('milliseconds', statement_timestamp()),
        now(),now()+interval '30 days',now(),$8,0) ON CONFLICT (id) DO NOTHING`,
    [id, actorUid, checksum, objectKey, objectGeneration, model.provider, model.model, randomInt(1, 1_000_000_000)]);
    const task = await this.find(id, true);
    if (!task) throw new Error('Slip task insert was not visible');
    return task;
  }

  async list(cursor?: Cursor): Promise<SlipTask[]> {
    const {rows} = await this.pool.query<SlipTask>(`
      SELECT id,status,created_at,updated_at,expires_at,failure_code FROM public.order_slip_task
      WHERE expires_at > now() AND ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 26`, [cursor?.time, cursor?.id]);
    return rows;
  }

  async dispatchCandidates(): Promise<Dispatch[]> {
    const {rows} = await this.pool.query<Dispatch>(`
      SELECT id,dispatch_generation FROM public.order_slip_task WHERE status='QUEUED'
      AND available_at <= now() AND expires_at > now() AND dispatched_at IS NULL
      ORDER BY available_at,id LIMIT 25`);
    return rows;
  }

  async dispatched(task: Dispatch) {
    await this.pool.query(`UPDATE public.order_slip_task SET dispatched_at=now()
      WHERE id=$1 AND dispatch_generation=$2 AND status='QUEUED' AND dispatched_at IS NULL`, [task.id, task.dispatch_generation]);
  }

  async claim(task: Dispatch): Promise<SlipTask | undefined> {
    const {rows} = await this.pool.query<SlipTask>(`
      UPDATE public.order_slip_task SET status='PROCESSING',updated_at=now(),attempts=attempts+1,
        lease_token=$3,lease_until=now()+interval '3 minutes'
      WHERE id=$1 AND dispatch_generation=$2 AND status='QUEUED' AND available_at <= now()
        AND expires_at > now() AND attempts < 3 RETURNING *`, [task.id, task.dispatch_generation, randomUUID()]);
    return rows[0];
  }

  async ready(task: SlipTask, preview: OrderSlipPreview) {
    await this.pool.query(`UPDATE public.order_slip_task SET status='READY',updated_at=now(),
      preview=$3,lease_token=NULL,lease_until=NULL,failure_code=NULL
      WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' AND lease_until > now() AND expires_at > now()`,
    [task.id, task.lease_token, JSON.stringify(preview)]);
  }

  async failed(task: SlipTask, code: FailureCode, retry: boolean) {
    await this.pool.query(`UPDATE public.order_slip_task
      SET status=CASE WHEN $4 AND attempts<3 THEN 'QUEUED' ELSE 'FAILED' END,
        failure_code=CASE WHEN $4 AND attempts<3 THEN NULL ELSE $3 END, updated_at=now(),
        available_at=now()+make_interval(secs => attempts*30), dispatch_generation=dispatch_generation+1,
        dispatched_at=NULL, lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$2 AND status='PROCESSING' AND lease_until > now() AND expires_at > now()`,
    [task.id, task.lease_token, code, retry]);
  }

  async recover() {
    await this.pool.query(`UPDATE public.order_slip_task
      SET status=CASE WHEN attempts>=3 OR created_at<=now()-interval '15 minutes' THEN 'FAILED' ELSE 'QUEUED' END,
        failure_code=CASE WHEN attempts>=3 OR created_at<=now()-interval '15 minutes' THEN 'processing_unavailable' ELSE NULL END,
        updated_at=now(), available_at=now(), dispatch_generation=dispatch_generation+1,
        dispatched_at=NULL,lease_token=NULL,lease_until=NULL
      WHERE expires_at > now() AND ((status='PROCESSING' AND lease_until <= now()) OR
        (status='QUEUED' AND (dispatched_at <= now()-interval '3 minutes' OR created_at<=now()-interval '15 minutes')))`);
  }

  async expired(): Promise<SlipTask[]> {
    const {rows} = await this.pool.query<SlipTask>(`
      SELECT id,object_key,object_generation FROM public.order_slip_task WHERE expires_at <= now()
      ORDER BY expires_at,id LIMIT 25`);
    return rows;
  }

  async purge(task: SlipTask) {
    await this.pool.query(`DELETE FROM public.order_slip_task WHERE id=$1 AND object_generation=$2 AND expires_at <= now()`,
      [task.id, task.object_generation]);
  }

  async catalog(): Promise<CatalogProduct[]> {
    const {rows} = await this.pool.query<CatalogProduct>(`
      SELECT id,name,chinese_name AS "chineseName" FROM public.product WHERE is_active ORDER BY id`);
    return rows;
  }
}
