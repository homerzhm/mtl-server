import {logger} from 'firebase-functions';
import {defineString} from 'firebase-functions/params';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {getPool} from './database';
import {HistoricalOrderImportService, requireHistoricalImportAdmin} from './historical-import';

const serviceAccount = defineString('ORDERS_RUNTIME_SERVICE_ACCOUNT');
const region = defineString('ORDERS_REGION', {default: 'northamerica-northeast1'});

export const importHistoricalOrder = onCall({region, serviceAccount, timeoutSeconds: 60, maxInstances: 1,
  concurrency: 2}, async request => {
  const actor = requireHistoricalImportAdmin(request.auth);
  try {
    return await new HistoricalOrderImportService(await getPool()).importOrder(actor, request.data);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('Historical order import failed', error);
    throw new HttpsError('internal', 'Import result uncertain; reconcile before retrying the same request');
  }
});
