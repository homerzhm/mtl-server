import {createHash} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import {uuid} from '../orders/booking';
import {Dispatch, FailureCode, SlipDatabase, SlipTask} from './database';
import {PhotoConflict, SlipStorage} from './infrastructure';
import {interpret, ModelSelection, SlipModelProvider} from './model';
import {checksum, decodePhoto, normalizePhoto} from './photo';
import {exactObject, InvalidPreview} from './preview';
import {RemoteFailure} from './transport';

type Dependencies = {
  database: Pick<SlipDatabase, keyof SlipDatabase>;
  storage: SlipStorage;
  enqueue(task: Dispatch): Promise<void>;
  selection(): ModelSelection;
  provider(selection: ModelSelection, signal: AbortSignal): Promise<SlipModelProvider>;
  operationalLog(event: string): void;
};

const summary = (task: SlipTask) => ({
  taskId: task.id, status: task.status, failureCode: task.failure_code,
  createdAt: task.created_at.toISOString(), updatedAt: task.updated_at.toISOString(), expiresAt: task.expires_at.toISOString(),
});

const invalid = () => new HttpsError('invalid-argument', 'Check the slip task fields');
const missing = () => new HttpsError('not-found', 'Slip task is unavailable');
const conflict = () => new HttpsError('already-exists', 'This slip request ID is already in use');

export class OrderSlipService {
  constructor(private readonly deps: Dependencies) {}

  private async dispatch(task: Dispatch) {
    try {
      await this.deps.enqueue(task);
      await this.deps.database.dispatched(task);
    } catch {
      this.deps.operationalLog('slip_dispatch_pending');
    }
  }

  async submit(uid: string, raw: unknown) {
    const input = exactObject(raw, ['requestId', 'photoBase64']);
    if (typeof input?.requestId !== 'string' || !uuid.test(input.requestId)) throw invalid();
    const id = input.requestId.toLowerCase();
    const photo = decodePhoto(input.photoBase64);
    const hash = checksum(photo);
    const {database, storage} = this.deps;
    const verify = (task: SlipTask) => {
      if (task.actor_uid !== uid || task.checksum !== hash) throw conflict();
      if (task.expires_at.getTime() <= Date.now()) throw missing();
      return task;
    };
    let task = await database.find(id, true);
    if (task) return summary(verify(task));

    const selection = this.deps.selection();
    const normalized = await normalizePhoto(photo);
    const actorKey = createHash('sha256').update(uid).digest('hex');
    const objectKey = `order-slips/${actorKey}/${id}.jpg`;
    let generation: string;
    try { generation = await storage.save(objectKey, normalized, hash); }
    catch (error) {
      if (error instanceof PhotoConflict) throw conflict();
      throw error;
    }
    task = verify(await database.insert(id, uid, hash, objectKey, generation, selection));
    if (task.status === 'QUEUED') await this.dispatch(task);
    return summary(task);
  }

  async read(raw: unknown) {
    if (!raw || typeof raw !== 'object') throw invalid();
    const {action} = raw as {action?: unknown};
    const {database, storage} = this.deps;
    if (action === 'get') {
      const hasPhoto = Object.hasOwn(raw, 'includePhoto');
      const input = exactObject(raw, hasPhoto ? ['action', 'taskId', 'includePhoto'] : ['action', 'taskId']);
      if (typeof input?.taskId !== 'string' || !uuid.test(input.taskId) ||
          (hasPhoto && typeof input.includePhoto !== 'boolean')) throw invalid();
      const task = await database.find(input.taskId.toLowerCase());
      if (!task) throw missing();
      let photoBase64: string | undefined;
      if (input.includePhoto) {
        try { photoBase64 = (await storage.read(task.object_key, task.object_generation)).toString('base64'); }
        catch (error) {
          if (error instanceof RemoteFailure && error.status === 404) throw missing();
          throw error;
        }
      }
      return {...summary(task), preview: task.preview, ...(photoBase64 ? {photoBase64} : {})};
    }
    if (action === 'list') {
      const hasCursor = Object.hasOwn(raw, 'cursor');
      const input = exactObject(raw, hasCursor ? ['action', 'cursor'] : ['action']);
      if (!input) throw invalid();
      let cursor: {time: string; id: string} | undefined;
      if (hasCursor) {
        if (typeof input.cursor !== 'string' || input.cursor.length > 100) throw invalid();
        const [time, id, extra] = input.cursor.split('/');
        if (extra !== undefined || !id || !uuid.test(id) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) ||
            !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) throw invalid();
        cursor = {time, id};
      }
      const rows = await database.list(cursor);
      const last = rows[24];
      return {tasks: rows.slice(0, 25).map(summary), nextCursor: rows.length > 25 ? `${last.created_at.toISOString()}/${last.id}` : null};
    }
    throw invalid();
  }

  async process(raw: unknown) {
    const input = exactObject(raw, ['taskId', 'generation']);
    if (typeof input?.taskId !== 'string' || !uuid.test(input.taskId) || typeof input.generation !== 'number' ||
        !Number.isInteger(input.generation) || input.generation < 1 || input.generation > 2147483647) return;
    const {database, storage} = this.deps;
    const task = await database.claim({id: input.taskId, dispatch_generation: input.generation});
    if (!task) return;
    const signal = AbortSignal.timeout(95000);
    let photoLoaded = false;
    let preview;
    try {
      const photo = await storage.read(task.object_key, task.object_generation, signal);
      photoLoaded = true;
      const provider = await this.deps.provider({provider: task.provider, model: task.model}, signal);
      preview = await interpret(provider, photo, () => database.catalog(), signal);
    } catch (error) {
      const invalid = error instanceof InvalidPreview;
      const permanentRemote = error instanceof RemoteFailure && error.status >= 400 && error.status < 500 &&
        ![408, 429].includes(error.status);
      const code: FailureCode = invalid ? 'invalid_preview' :
        !photoLoaded && error instanceof RemoteFailure && error.status === 404 ? 'photo_unavailable' : 'processing_unavailable';
      this.deps.operationalLog(`slip_${code}`);
      await database.failed(task, code, !invalid && !permanentRemote);
      return;
    }
    await database.ready(task, preview);
  }

  async reconcile() {
    const {database, storage} = this.deps;
    await database.recover();
    await Promise.all((await database.dispatchCandidates()).map(task => this.dispatch(task)));
    await Promise.all((await database.expired()).map(async task => {
      try {
        await storage.remove(task.object_key, task.object_generation);
        await database.purge(task);
      } catch {
        this.deps.operationalLog('slip_cleanup_pending');
      }
    }));
  }
}
