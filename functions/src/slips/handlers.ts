import {logger} from 'firebase-functions';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {onTaskDispatched} from 'firebase-functions/v2/tasks';
import {isEmulator, selectedModel, slipsBucket, slipsIdentity, slipsOpenAISecret, slipsRegion, vertexServing} from './config';
import {slipDatabase} from './database';
import {bucketStorage, taskQueue} from './infrastructure';
import {createProvider} from './providers';
import {OrderSlipService} from './service';
import {googleTransport} from './transport';

const base = {region: slipsRegion, serviceAccount: slipsIdentity, maxInstances: 1, concurrency: 2};
const callableOptions = {...base, timeoutSeconds: 60, memory: '512MiB'} as const;

export function requireSlipAdmin(auth?: {uid: string; token: Record<string, unknown>}): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in');
  const firebase = auth.token.firebase as {sign_in_provider?: unknown} | undefined;
  if (!auth.uid || firebase?.sign_in_provider !== 'google.com' || auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
  return auth.uid;
}

async function service() {
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('Slip project unavailable');
  const request = isEmulator() ? async () => { throw new Error('Slip emulator cloud access is disabled'); } : googleTransport();
  return new OrderSlipService({
    database: await slipDatabase(),
    storage: bucketStorage(slipsBucket.value(), request),
    enqueue: taskQueue(project, slipsRegion.value(), slipsIdentity.value(), request),
    selection: selectedModel,
    provider: (selection, signal) => {
      if (isEmulator()) throw new Error('Slip emulator provider is disabled');
      return createProvider(selection, project, request, slipsOpenAISecret.value(), signal, vertexServing);
    },
    operationalLog: event => logger.warn(event),
  });
}

async function callable<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.warn('slip_callable_unavailable');
    throw new HttpsError('unavailable', 'Slip task service is unavailable');
  }
}

export const submitOrderSlipTask = onCall(callableOptions, request => {
  const uid = requireSlipAdmin(request.auth);
  return callable(async () => (await service()).submit(uid, request.data));
});

export const readOrderSlipTasks = onCall(callableOptions, request => {
  requireSlipAdmin(request.auth);
  return callable(async () => (await service()).read(request.data));
});

export const processOrderSlipTask = onTaskDispatched({
  ...base, timeoutSeconds: 120, invoker: slipsIdentity.toCEL(),
  retryConfig: {maxAttempts: 5, minBackoffSeconds: 15, maxBackoffSeconds: 60},
  rateLimits: {maxConcurrentDispatches: 2, maxDispatchesPerSecond: 2},
}, async request => {
  try { await (await service()).process(request.data); }
  catch {
    logger.warn('slip_worker_unavailable');
    throw new HttpsError('unavailable', 'Slip worker is unavailable');
  }
});

export const reconcileOrderSlipTasks = onSchedule({...base, timeoutSeconds: 120, schedule: 'every 1 minutes'},
  async () => {
    try { await (await service()).reconcile(); }
    catch {
      logger.warn('slip_reconcile_unavailable');
      throw new Error('Slip reconciliation unavailable');
    }
  });
