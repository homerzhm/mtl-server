import {parseArgs} from 'node:util';
import {getAdminApp} from '../shared/firebase';
import {getAuth} from 'firebase-admin/auth';
import {closeDatabase, getPool} from './database';
import {StaffService} from './service';

async function main() {
  const {values} = parseArgs({options: {
    project: {type: 'string'}, 'bootstrap-admin': {type: 'string'}, reconcile: {type: 'boolean', default: false},
  }});
  if (!values.project) throw new Error('Pass --project explicitly');
  process.env.GCLOUD_PROJECT = values.project;
  const app = getAdminApp({projectId: values.project});
  const service = new StaffService(await getPool(), getAuth(app));
  if (values.reconcile) {
    const result = await service.reconcile();
    console.log(JSON.stringify(result));
    if (result.status === 'FAILED') throw new Error('Claim synchronization still failing');
  } else {
    const imported = await service.importExisting();
    await service.ensureAdmin(values['bootstrap-admin']);
    console.log(JSON.stringify({imported, status: 'ready'}));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeDatabase);
