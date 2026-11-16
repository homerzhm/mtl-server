import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {root, functions, digest, stableJson} from './config.mjs';
import {operatorAuth} from './auth.mjs';
export async function googleGet(url) {
  const auth=operatorAuth();
  const parsed=new URL(url),params=Object.fromEntries(parsed.searchParams);
  parsed.search='';
  const response=await auth.request({url:parsed.toString(),method:'GET',params});
  return response.data;
}
async function sources(directory) {
  const files=(await readdir(join(root,directory))).filter(f=>/\.(gql|graphql)$/.test(f)).sort();
  return Promise.all(files.map(async path=>({path,content:await readFile(join(root,directory,path),'utf8')})));
}
function assertSources(actual,expected,label) {
  const normalize=files=>(files??[]).map(f=>({path:f.path,content:f.content})).sort((a,b)=>a.path.localeCompare(b.path));
  if(JSON.stringify(normalize(actual))!==JSON.stringify(normalize(expected))) throw new Error(`Deployed ${label} sources differ from checkout`);
}
export async function verifyCloud(t,parameters,component='all',get=googleGet) {
  const base=`projects/${t.project}/locations/${t.region}`;
  const functionsBase=`projects/${t.project}/locations/${t.functionsRegion}`;
  const result={};
  if(component==='all'||component==='schema') {
    const schema=await get(`https://firebasedataconnect.googleapis.com/v1/${base}/services/restaurant/schemas/main`);
    assertSources(schema.source?.files,await sources('dataconnect/schema'),'schema');
    const sql=schema.datasources?.[0]?.postgresql;
    // REST resource shape uses database and cloudSql.instance.
    if(sql?.database!=='restaurant' || sql?.cloudSql?.instance!==`projects/${t.project}/locations/${t.region}/instances/${t.instance}` || sql?.schemaValidation!=='COMPATIBLE') throw new Error('Deployed SQL Connect datasource differs from target');
    result.schema={name:schema.name,source:{files:[...schema.source.files].sort((a,b)=>a.path.localeCompare(b.path))},datasources:schema.datasources};
  }
  if(component==='all'||component==='connector') {
    const connector=await get(`https://firebasedataconnect.googleapis.com/v1/${base}/services/restaurant/connectors/staff-admin`);
    assertSources(connector.source?.files,await sources('dataconnect/staff-admin'),'connector');
    result.connector={name:connector.name,source:{files:[...connector.source.files].sort((a,b)=>a.path.localeCompare(b.path))}};
  }
  if(component==='all'||component==='functions') {
    const deployed=[];
    let pageToken;
    do {
      const page=await get(`https://cloudfunctions.googleapis.com/v2/${functionsBase}/functions${pageToken?`?pageToken=${encodeURIComponent(pageToken)}`:''}`);
      deployed.push(...(page.functions??[]));pageToken=page.nextPageToken;
    } while(pageToken);
    const ours=deployed.filter(f=>f.labels?.['firebase-functions-codebase']==='server');
    if(JSON.stringify(ours.map(f=>f.name.split('/').at(-1)).sort())!==JSON.stringify([...functions].sort())) throw new Error('Deployed server Function inventory differs');
    for(const f of ours) {
      const name=f.name.split('/').at(-1),staff=['registerStaffSignIn','setStaffRoles','reconcileStaffRoles'].includes(name);
      const topic=staff?'STAFF':'ORDERS';
      if(f.state!=='ACTIVE'||f.buildConfig?.runtime!=='nodejs22'||f.serviceConfig?.serviceAccountEmail!==parameters[`${topic}_RUNTIME_SERVICE_ACCOUNT`] ||
          f.serviceConfig?.maxInstanceCount!==1 || f.serviceConfig?.maxInstanceRequestConcurrency!==2 || f.serviceConfig?.timeoutSeconds!==(staff?120:60)) throw new Error(`Function runtime mismatch: ${name}`);
      const env=f.serviceConfig.environmentVariables??{};
      for(const suffix of ['SQL_INSTANCE','SQL_USER','SQL_DATABASE']) if(env[`${topic}_${suffix}`]!==parameters[`${topic}_${suffix}`]) throw new Error(`Function database parameters differ: ${name}`);
      if(Object.keys(env).some(k=>k.includes('EMULATOR')||k.endsWith('LOCAL_DATABASE_URL'))) throw new Error(`Emulator settings deployed: ${name}`);
    }
    const job=await get(`https://cloudscheduler.googleapis.com/v1/${functionsBase}/jobs/firebase-schedule-reconcileStaffRoles-${t.functionsRegion}`);
    const normalize=url=>url?.replace(/\/$/,'');
    const allowedTargets=[ours.find(f=>f.name.endsWith('/reconcileStaffRoles'))?.serviceConfig?.uri,
      `https://${t.functionsRegion}-${t.project}.cloudfunctions.net/reconcileStaffRoles`].map(normalize);
    if(job.state!=='ENABLED'||!['* * * * *','every 1 minutes'].includes(job.schedule)||
      !allowedTargets.includes(normalize(job.httpTarget?.uri))||job.httpTarget?.httpMethod!=='POST'||
      job.httpTarget?.oidcToken?.serviceAccountEmail!==parameters.STAFF_RUNTIME_SERVICE_ACCOUNT||
      (job.httpTarget.oidcToken.audience&&normalize(job.httpTarget.oidcToken.audience)!==normalize(job.httpTarget.uri))) throw new Error('Staff reconciliation scheduler differs');
    result.functions=ours.sort((a,b)=>a.name.localeCompare(b.name)).map(f=>({name:f.name,updateTime:f.updateTime,buildConfig:f.buildConfig,serviceConfig:f.serviceConfig}));
    result.scheduler={name:job.name,state:job.state,schedule:job.schedule,timeZone:job.timeZone,httpTarget:job.httpTarget,retryConfig:job.retryConfig};
  }
  if(component==='all') {
    const instance=await get(`https://sqladmin.googleapis.com/sql/v1beta4/projects/${t.project}/instances/${t.instance}`);
    if(instance.connectionName!==t.connection||instance.region!==t.region||instance.state!=='RUNNABLE'||!instance.databaseVersion?.startsWith('POSTGRES_')||
      !instance.settings?.databaseFlags?.some(f=>f.name==='cloudsql.iam_authentication'&&f.value==='on')) throw new Error('Cloud SQL target/IAM configuration differs');
    if(t.name==='production' && (!instance.settings.backupConfiguration?.enabled||!instance.settings.backupConfiguration?.pointInTimeRecoveryEnabled)) throw new Error('Production backups and point-in-time recovery required');
    result.instance={connection:instance.connectionName,version:instance.databaseVersion,flags:[...instance.settings.databaseFlags].sort((a,b)=>a.name.localeCompare(b.name))};
  }
  return digest(stableJson(result));
}
