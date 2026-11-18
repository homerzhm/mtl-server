import {logger} from 'firebase-functions';
import {defineString} from 'firebase-functions/params';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {getReportPool} from './database';
import {parseReportRequest, ReportService, requireReportAdmin} from './service';

const runtimeServiceAccount = defineString('REPORT_RUNTIME_SERVICE_ACCOUNT');
const region = defineString('REPORT_REGION', {default: 'northamerica-northeast1'});

export const manageReportEntries = onCall({
  region, serviceAccount: runtimeServiceAccount, timeoutSeconds: 60, maxInstances: 1, concurrency: 2,
}, async request => {
  const actor = requireReportAdmin(request.auth);
  const input = parseReportRequest(request.data, actor.uid);
  try {
    const service = new ReportService(await getReportPool());
    return input.action === 'list' ? await service.list(input) : await service.write(actor, input);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    // The underlying database error can contain entry values and notes.
    logger.error('Report request failed', {action: input.action});
    throw new HttpsError('internal', 'Could not complete the Report request.');
  }
});
