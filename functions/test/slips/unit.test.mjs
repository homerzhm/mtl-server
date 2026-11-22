import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readOrderSlipTasks, requireSlipAdmin, submitOrderSlipTask} from '../../lib/slips/handlers.js';
import {decodePhoto, normalizePhoto} from '../../lib/slips/photo.js';
import {interpret, searchCatalog} from '../../lib/slips/model.js';
import {createProvider, vertexProvider, openAIProvider} from '../../lib/slips/providers.js';
import {taskQueue, bucketStorage} from '../../lib/slips/infrastructure.js';
import {validatePreview} from '../../lib/slips/preview.js';
import {catalog, id, preview, productId, provider, unknown} from './fixtures.mjs';

const deadline = () => AbortSignal.timeout(5000);

test('slip callables require a strict Boolean Admin claim from Google before using dependencies', async () => {
  for (const handler of [submitOrderSlipTask,readOrderSlipTasks]) {
    await assert.rejects(async () => handler.run({data:{}}), {code:'unauthenticated'});
    for (const token of [
      {staff:true,firebase:{sign_in_provider:'google.com'}},
      {admin:'true',firebase:{sign_in_provider:'google.com'}},
      {admin:true,firebase:{sign_in_provider:'password'}},
    ]) {
      await assert.rejects(async () => handler.run({auth:{uid:'admin',token},data:{}}), {code:'permission-denied'});
    }
  }
  assert.equal(requireSlipAdmin({uid:'admin',token:{admin:true,firebase:{sign_in_provider:'google.com'}}}), 'admin');
});

test('JPEG validation bounds input and strips metadata during resize', async () => {
  const jpeg=await sharp({create:{width:2500,height:100,channels:3,background:'white'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const normalized=await normalizePhoto(decodePhoto(jpeg.toString('base64')));
  const metadata=await sharp(normalized).metadata();
  assert.equal(metadata.height,2400);
  assert.equal(metadata.orientation,undefined);
  assert.throws(() => decodePhoto('////'), {code:'invalid-argument'});
  assert.throws(() => decodePhoto(Buffer.alloc(4*1024*1024+1,255).toString('base64')), {code:'invalid-argument'});
  await assert.rejects(normalizePhoto(Buffer.from([255,216,0])), {code:'invalid-argument'});
});

test('preview carries independent evidence and confidence and copies PAY exactly', () => {
  const raw=preview();
  raw.prefill.depositReceivedCents=unknown();
  raw.prefill.items.push(structuredClone(raw.prefill.items[0]));
  const result=validatePreview(raw,catalog);
  assert.equal(result.prefill.items.length,3);
  assert.equal(result.prefill.items[1].quantity.confidence,'unknown');
  assert.equal(result.prefill.pickup.year.value,null);
  assert.equal(result.prefill.pickup.meridiem.value,null);
  assert.equal(result.prefill.contactPhoneNumber.value,'+14165550100');
  assert.deepEqual(result.prefill.depositReceivedCents,result.paperAmounts.payCents);
});

test('rejects invalid evidence, confidence, product IDs, quantities, dates and CAD cents', () => {
  for (const mutate of [
    p=>p.sources.push(p.sources[0]),
    p=>p.prefill.items[0].productId.sourceLineIds=['invented'],
    p=>p.prefill.items[0].productId.value=id,
    p=>p.prefill.items[0].quantity.value=100,
    p=>p.prefill.items[0].quantity.confidence='unknown',
    p=>p.prefill.pickup.month.value=2,
    p=>p.paperAmounts.payCents.value=20.50,
    p=>p.paperAmounts.payCents.value=-1,
  ]) {
    const raw=preview();
    mutate(raw);
    if (raw.prefill.pickup.month.value===2) raw.prefill.pickup.day.value=31;
    assert.throws(()=>validatePreview(raw,catalog),/Invalid slip preview/);
  }
});

test('catalog lookups validate tool input and cap results and calls', async () => {
  assert.equal(searchCatalog({query:'燒豬'},catalog)[0].id, productId);
  assert.throws(() => searchCatalog({query:'pork',sql:'SELECT *'},catalog), /Invalid slip preview/);
  assert.equal(searchCatalog({query:'roast'},Array.from({length:8},(_,index)=>({...catalog[0],id:String(index)}))).length,5);
  const run = calls => interpret({start:()=>({turn:async()=>({calls})})}, Buffer.alloc(0),catalog,deadline());
  await assert.rejects(run([{name:'createOrder',args:{}}]),/Invalid slip preview/);
  await assert.rejects(run(Array.from({length:5},()=>({name:'searchActiveCatalog',args:{query:'pork'}}))),/Invalid slip preview/);
  await assert.rejects(interpret(provider(),Buffer.alloc(0),[],deadline()),/Invalid slip preview/);
});

for (const engine of ['vertex','openai']) {
  test(`${engine} sends one photo and carries tool results into the structured final turn`, async () => {
    const requests=[];
    const request=async (url,body,signal,headers) => {
      requests.push({url,body:structuredClone(body),signal,headers});
      if (requests.length===1) {
        return engine==='vertex'
          ? {candidates:[{finishReason:'STOP',content:{role:'model',parts:[{thoughtSignature:'signature',
              functionCall:{name:'searchActiveCatalog',args:{query:'roast'}}}]}}]}
          : {status:'completed',output:[{type:'function_call',call_id:'call_1',name:'searchActiveCatalog',arguments:'{"query":"roast"}'}]};
      }
      const text=requests.length===2?'I have the matches':JSON.stringify(preview());
      return engine==='vertex'
        ? {candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text}]}}]}
        : {status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]};
    };
    const model=engine==='vertex'?vertexProvider('test-project','gemini-3.8-flash',request):openAIProvider('gpt-5.4-mini',request);
    const result=await interpret(model,Buffer.from('photo'),catalog,deadline());
    assert.equal(result.prefill.items[0].productId.value,productId);
    assert.equal(requests.length,3);
    assert.equal(requests[2].body.tools,undefined);
    if (engine==='vertex') {
      assert.match(requests[0].url,/northamerica-northeast1-aiplatform.*locations\/northamerica-northeast1.*gemini-3.8-flash/);
      assert.equal(requests[0].headers['X-Vertex-AI-LLM-Request-Type'],'dedicated');
      assert.equal(requests[0].body.contents[0].parts[0].inlineData.data,'cGhvdG8=');
      assert.match(JSON.stringify(requests[1].body.contents),/thoughtSignature.*functionResponse.*matches/);
      assert.equal(requests[2].body.generationConfig.responseMimeType,'application/json');
    } else {
      assert.equal(requests[0].url,'https://api.openai.com/v1/responses');
      assert.equal(requests[0].body.store,false);
      assert.equal(requests[0].body.input[0].content[0].image_url,'data:image/jpeg;base64,cGhvdG8=');
      assert.equal(requests[1].body.input.find(part=>part.type==='function_call_output').call_id,'call_1');
      assert.equal(requests[2].body.text.format.strict,true);
    }
  });
}

test('storage upload and task dispatch use generation guards and metadata-only queue payloads', async () => {
  const requests=[];
  const request=async (url,options) => {
    requests.push({url,options});
    if(url.includes('storage')) {
      if(options.method==='POST') return new Response(null,{status:412});
      if(options.method==='DELETE') return new Response(null,{status:404});
      return Response.json({generation:'123',metadata:{checksum:'hash'}});
    }
    return new Response(null,{status:409});
  };
  const storage=bucketStorage('fixture',request);
  assert.equal(await storage.save('order-slips/test.jpg',Buffer.from('photo'),'hash'),'123');
  await assert.rejects(storage.save('order-slips/test.jpg',Buffer.from('changed'),'other'),/conflicts/);
  await storage.remove('order-slips/test.jpg','123');
  await taskQueue('fixture','northamerica-northeast1','slips@fixture.iam.gserviceaccount.com',request)({id,dispatch_generation:4});
  assert.match(requests[0].url,/ifGenerationMatch=0/);
  assert.match(requests.at(-2).url,/generation=123&ifGenerationMatch=123/);
  const task=JSON.parse(requests.at(-1).options.body).task;
  assert.deepEqual(JSON.parse(Buffer.from(task.httpRequest.body,'base64')),{data:{taskId:id,generation:4}});
  assert.equal(task.httpRequest.url,task.httpRequest.oidcToken.audience);
});


test('OpenAI reads only the configured Secret Manager secret and sends its key as authorization', async t => {
  const urls=[];
  const signal=deadline();
  const fetch=t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization,'Bearer fixture-key');
    assert.equal(options.signal,signal);
    assert.equal(JSON.parse(options.body).store,false);
    assert.doesNotMatch(options.body,/fixture-key/);
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});
  });
  const google=async url=>{
    urls.push(url);
    return Response.json({payload:{data:Buffer.from('fixture-key').toString('base64')}});
  };
  const model=await createProvider({provider:'openai',model:'fixture-model'},'fixture',google,'test-key',signal);
  await model.start(Buffer.from('image'),signal).turn({final:true,results:[]});
  assert.deepEqual(urls,['https://secretmanager.googleapis.com/v1/projects/fixture/secrets/test-key/versions/latest:access']);
  assert.equal(fetch.mock.callCount(),1);
});
