import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readOrderSlipTasks, requireSlipAdmin, submitOrderSlipTask} from '../../lib/slips/handlers.js';
import {decodePhoto, normalizePhoto} from '../../lib/slips/photo.js';
import {interpret} from '../../lib/slips/model.js';
import {createProvider, vertexProvider, responsesProvider} from '../../lib/slips/providers.js';
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

test('reviews only a validated transcript and validates product IDs and citations against the supplied inputs', async () => {
  const loadCatalog = async () => catalog;
  const raw = preview();
  const invalidTranscript = provider({...raw, sources: [raw.sources[0], raw.sources[0]]});
  await assert.rejects(interpret(invalidTranscript, Buffer.alloc(0),
    async () => assert.fail('Catalog loaded for an invalid transcript'), deadline()), /Invalid slip preview/);
  await assert.rejects(interpret(provider(), Buffer.alloc(0), async () => [], deadline()), /Invalid slip preview/);
  raw.prefill.items[0].productId.sourceLineIds = ['invented'];
  await assert.rejects(interpret(provider(raw), Buffer.alloc(0), loadCatalog, deadline()), /Invalid slip preview/);
});

for (const {name, serving, host, provider, modelName} of [
  {name:'Montréal Vertex', serving:{location:'northamerica-northeast1',requestType:'dedicated'}, host:'northamerica-northeast1-aiplatform.googleapis.com'},
  {name:'US Vertex', serving:{location:'us',requestType:'shared'}, host:'aiplatform.us.rep.googleapis.com'},
  {name:'OpenAI', provider:'openai', modelName:'gpt-5.4-mini'},
  {name:'DeepSeek', provider:'deepseek', modelName:'deepseek-flash'},
]) {
  test(`${name} transcribes the photo and reviews the transcript with the active catalog`, async () => {
    const requests = [];
    const events = [];
    const {sources, prefill, paperAmounts} = preview();
    sources[0].text = '60 LB';
    prefill.items[0].quantity = {...unknown(), sourceLineIds: [sources[0].id]};
    const activeCatalog = [{...catalog[0], name: '60lb'}, catalog[1]];
    const request = async (url, body, signal, headers) => {
      requests.push({url, body: structuredClone(body), signal, headers});
      events.push(requests.length === 1 ? 'transcribe' : 'review');
      const text = JSON.stringify(requests.length === 1 ? {sources} : {prefill, paperAmounts});
      return serving
        ? {candidates: [{finishReason: 'STOP', content: {parts: [{text}]}}]}
        : {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text}]}]};
    };
    const model = serving ? vertexProvider('test-project', 'gemini-3.8-flash', request, serving)
      : responsesProvider(provider, modelName, request);
    const result = await interpret(model, Buffer.from('photo'), async () => {
      events.push('load catalog');
      return activeCatalog;
    }, deadline());
    assert.deepEqual(events, ['transcribe', 'load catalog', 'review']);
    assert.deepEqual(result.sources, sources);
    assert.equal(result.prefill.items[0].productId.value, productId);
    assert.equal(result.prefill.items[0].quantity.value, null);
    const [transcription, review] = requests.map(({body}) => body);
    for (const {url, body, headers} of requests) {
      assert.equal(body.tools, undefined);
      if (serving) {
        assert.equal(url, `https://${host}/v1/projects/test-project/locations/${serving.location}/publishers/google/models/gemini-3.8-flash:generateContent`);
        assert.equal(headers['X-Vertex-AI-LLM-Request-Type'], serving.requestType);
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
      } else {
        assert.equal(body.model, modelName);
        assert.equal(body.text.format.type, 'json_schema');
        if (provider === 'deepseek') {
          assert.equal(url, 'https://api.deepseek.com/responses');
          assert.equal(body.store, undefined);
          assert.equal(body.text.format.strict, undefined);
        } else {
          assert.equal(url, 'https://api.openai.com/v1/responses');
          assert.equal(body.store, false);
          assert.equal(body.text.format.strict, true);
        }
      }
    }
    if (serving) {
      assert.equal(transcription.contents[0].parts[0].inlineData.data, 'cGhvdG8=');
      assert.deepEqual(review.contents[0].parts, [{text: JSON.stringify({sources, catalog: activeCatalog})}]);
    } else {
      assert.equal(transcription.input[0].content[0].image_url, 'data:image/jpeg;base64,cGhvdG8=');
      assert.equal(review.input[0].content, JSON.stringify({sources, catalog: activeCatalog}));
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


for (const [provider, endpoint] of [['openai','https://api.openai.com/v1/responses'], ['deepseek','https://api.deepseek.com/responses']]) {
  test(`${provider} reads only its configured secret and sends its key as authorization`, async t => {
    const urls=[];
    const signal=deadline();
    const fetch=t.mock.method(globalThis,'fetch',async (url,options)=>{
      assert.equal(url,endpoint);
      assert.equal(options.headers.Authorization,'Bearer fixture-key');
      assert.equal(options.signal,signal);
      assert.doesNotMatch(options.body,/fixture-key/);
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});
    });
    const google=async url=>{
      urls.push(url);
      return Response.json({payload:{data:Buffer.from('fixture-key').toString('base64')}});
    };
    const model=await createProvider({provider,model:'fixture-model'},'fixture',google, selected => {
      assert.equal(selected,provider);
      return `test-${selected}-key`;
    },signal,()=>assert.fail('External provider should not resolve Vertex settings'));
    await model.transcribe(Buffer.from('image'),signal);
    assert.deepEqual(urls,[`https://secretmanager.googleapis.com/v1/projects/fixture/secrets/test-${provider}-key/versions/latest:access`]);
    assert.equal(fetch.mock.callCount(),1);
  });
}
