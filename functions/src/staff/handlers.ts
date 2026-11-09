import {getAdminApp} from '../shared/firebase';
import {getAuth} from 'firebase-admin/auth';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {logger} from 'firebase-functions';
import {defineString} from 'firebase-functions/params';
import {getPool} from './database';
import {requireGoogle, StaffService, type Caller} from './service';

const runtimeServiceAccount = defineString('STAFF_RUNTIME_SERVICE_ACCOUNT');
const options = {region: 'northamerica-northeast1', timeoutSeconds: 120, maxInstances: 5,
  serviceAccount: runtimeServiceAccount};

async function service() { return new StaffService(await getPool(), getAuth(getAdminApp())); }

async function callable<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('Staff operation failed', error);
    throw new HttpsError('internal', 'Staff operation failed; refresh the account before retrying');
  }
}

export const registerStaffSignIn = onCall(options, request => callable(async () => {
  const caller = requireGoogle(request.auth as Caller | undefined);
  return accountResponse(await (await service()).register(caller, request.data));
}));

export const setStaffRoles = onCall(options, request => callable(async () => {
  const caller = requireGoogle(request.auth as Caller | undefined, true);
  return accountResponse(await (await service()).setRoles(caller, request.data));
}));

// Callable encoding does not serialize Date objects as ISO timestamps itself.
function accountResponse<T extends {createdAt: Date; lastSignInAt: Date | null}>(account: T) {
  return {...account, createdAt: account.createdAt.toISOString(), lastSignInAt: account.lastSignInAt?.toISOString() ?? null};
}

export const reconcileStaffRoles = onSchedule({...options, schedule: 'every 1 minutes', retryCount: 3}, async () => {
  const result = await (await service()).reconcile();
  if (result.status === 'FAILED') {
    logger.error('Staff claim synchronization needs retry', result);
    throw new Error('STAFF_SYNC_FAILED');
  }
});
