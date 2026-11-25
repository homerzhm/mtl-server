import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {root, functions, slipFunctions, slipSettings, slipDefaults, digest, stableJson} from './config.mjs';
import {operatorAuth} from './auth.mjs';
export async function googleGet(url, method = 'GET') {
  const auth=operatorAuth();
  const parsed=new URL(url),params=Object.fromEntries(parsed.searchParams);
  parsed.search='';
  const response=await auth.request({url:parsed.toString(),method,params});
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
      const slips=slipFunctions.includes(name);
      const topic=staff?'STAFF':slips?'SLIPS':name==='manageReportEntries'?'REPORT':'ORDERS';
      const timeout=staff||['processOrderSlipTask','reconcileOrderSlipTasks'].includes(name)?120:60;
      if(f.state!=='ACTIVE'||f.buildConfig?.runtime!=='nodejs22'||f.serviceConfig?.serviceAccountEmail!==parameters[`${topic}_RUNTIME_SERVICE_ACCOUNT`] ||
          f.serviceConfig?.maxInstanceCount!==1 || f.serviceConfig?.maxInstanceRequestConcurrency!==2 || f.serviceConfig?.timeoutSeconds!==timeout) throw new Error(`Function runtime mismatch: ${name}`);
      const env=f.serviceConfig.environmentVariables??{};
      const suffixes=['SQL_INSTANCE','SQL_USER','SQL_DATABASE','REGION',...(slips?slipSettings:[])];
      for(const suffix of suffixes) {
        const key=`${topic}_${suffix}`,fallback=slipDefaults[key];
        if((env[key]??fallback)!==(parameters[key]??fallback)) throw new Error(`Function parameters differ: ${name}`);
      }
      if(Object.keys(env).some(k=>k.includes('EMULATOR')||k.endsWith('LOCAL_DATABASE_URL'))) throw new Error(`Emulator settings deployed: ${name}`);
    }
    const normalize=url=>url?.replace(/\/$/,'');
    async function scheduler(name, identity) {
      const job=await get(`https://cloudscheduler.googleapis.com/v1/${functionsBase}/jobs/firebase-schedule-${name}-${t.functionsRegion}`);
      const targets=[ours.find(f=>f.name.endsWith(`/${name}`))?.serviceConfig?.uri,
        `https://${t.functionsRegion}-${t.project}.cloudfunctions.net/${name}`].map(normalize);
      if(job.state!=='ENABLED'||!['* * * * *','every 1 minutes'].includes(job.schedule)||
        !targets.includes(normalize(job.httpTarget?.uri))||job.httpTarget?.httpMethod!=='POST'||
        job.httpTarget?.oidcToken?.serviceAccountEmail!==identity||
        (job.httpTarget?.oidcToken.audience&&normalize(job.httpTarget.oidcToken.audience)!==normalize(job.httpTarget.uri)))
        throw new Error(`${name} scheduler differs`);
      return {name:job.name,state:job.state,schedule:job.schedule,timeZone:job.timeZone,httpTarget:job.httpTarget,retryConfig:job.retryConfig};
    }
    result.functions=ours.sort((a,b)=>a.name.localeCompare(b.name)).map(f=>({name:f.name,updateTime:f.updateTime,buildConfig:f.buildConfig,serviceConfig:f.serviceConfig}));
    result.scheduler=await scheduler('reconcileStaffRoles', parameters.STAFF_RUNTIME_SERVICE_ACCOUNT);
    const identity=parameters.SLIPS_RUNTIME_SERVICE_ACCOUNT;
    result.slipScheduler=await scheduler('reconcileOrderSlipTasks', identity);
    const queueName=`${functionsBase}/queues/processOrderSlipTask`;
    const queue=await get(`https://cloudtasks.googleapis.com/v2/${queueName}`);
    if(queue.name!==queueName||queue.state!=='RUNNING'||queue.httpTarget||
      queue.rateLimits?.maxConcurrentDispatches!==2||queue.rateLimits?.maxDispatchesPerSecond!==2||
      queue.retryConfig?.maxAttempts!==5||!/^15(?:\.0+)?s$/.test(queue.retryConfig?.minBackoff)||
      !/^60(?:\.0+)?s$/.test(queue.retryConfig?.maxBackoff)) throw new Error('Slip task queue differs');
    const queuePolicy=await get(`https://cloudtasks.googleapis.com/v2/${queueName}:getIamPolicy`, 'POST');
    const enqueuers=(queuePolicy.bindings??[]).filter(binding=>binding.role==='roles/cloudtasks.enqueuer');
    if(enqueuers.length!==1||enqueuers[0].condition||JSON.stringify(enqueuers[0].members)!==JSON.stringify([`serviceAccount:${identity}`]))
      throw new Error('Slip task queue enqueuer policy differs');
    result.slipQueue={name:queue.name, state:queue.state, rateLimits:queue.rateLimits, retryConfig:queue.retryConfig,enqueuers};
    const worker=ours.find(f=>f.name.endsWith('/processOrderSlipTask'));
    const service=worker?.serviceConfig?.service;
    if(service!==`${functionsBase}/services/processordersliptask`) throw new Error('Slip worker service differs');
    const policy=await get(`https://run.googleapis.com/v2/${service}:getIamPolicy`);
    const invokers=(policy.bindings??[]).filter(binding=>binding.role==='roles/run.invoker');
    if(invokers.length!==1||invokers[0].condition||JSON.stringify(invokers[0].members)!==JSON.stringify([`serviceAccount:${identity}`])||
      (policy.bindings??[]).some(binding=>binding.members?.some(member=>['allUsers','allAuthenticatedUsers'].includes(member))))
      throw new Error('Slip worker invoker policy differs');
    result.slipWorkerInvokers=invokers;
    const bucket=await get(`https://storage.googleapis.com/storage/v1/b/${parameters.SLIPS_BUCKET}`);
    if(bucket.name!==parameters.SLIPS_BUCKET||bucket.location?.toLowerCase()!==t.functionsRegion||
      bucket.iamConfiguration?.publicAccessPrevention!=='enforced'||!bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled||
      bucket.versioning?.enabled||Number(bucket.softDeletePolicy?.retentionDurationSeconds??0)!==0||
      Number(bucket.retentionPolicy?.retentionPeriod??0)!==0||stableJson(bucket.lifecycle?.rule)!==
        stableJson([{action:{type:'Delete'},condition:{age:30}}])) throw new Error('Slip photo bucket policy differs');
    result.slipBucket={name:bucket.name,location:bucket.location,iamConfiguration:bucket.iamConfiguration,lifecycle:bucket.lifecycle};
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
