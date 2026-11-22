import {GoogleRequest, ProviderRequest, readJson} from './transport';
import {ModelSelection, reviewInstruction, SlipModelProvider, transcriptionInstruction} from './model';
import {InvalidPreview, reviewSchema, transcriptSchema} from './preview';
import type {VertexServing} from './config';

function parse(text: string | undefined): unknown {
  if (!text) throw new InvalidPreview();
  try { return JSON.parse(text); }
  catch { throw new InvalidPreview(); }
}

export function vertexProvider(project: string, model: string, request: ProviderRequest, serving: VertexServing): SlipModelProvider {
  const {location, requestType} = serving;
  const host = location === 'us' ? 'aiplatform.us.rep.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  async function generate(instruction: string, part: unknown, schema: object, signal: AbortSignal) {
    const response = await request(url, {
      systemInstruction: {parts: [{text: instruction}]},
      contents: [{role: 'user', parts: [part]}],
      generationConfig: {
        maxOutputTokens: 12288,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    }, signal, {'X-Vertex-AI-LLM-Request-Type': requestType}) as {
      candidates?: {finishReason?: string; content?: {parts?: {text?: string; thought?: boolean}[]}}[];
    };
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new InvalidPreview();
    return parse(candidate.content.parts.filter(part => !part.thought).map(part => part.text ?? '').join(''));
  }
  return {
    transcribe: (photo, signal) => generate(transcriptionInstruction,
      {inlineData: {mimeType: 'image/jpeg', data: photo.toString('base64')}}, transcriptSchema, signal),
    review: (sources, catalog, signal) => generate(reviewInstruction,
      {text: JSON.stringify({sources, catalog})}, reviewSchema, signal),
  };
}

type ResponsesProvider = Exclude<ModelSelection['provider'], 'vertex'>;

export function responsesProvider(provider: ResponsesProvider, model: string, request: ProviderRequest): SlipModelProvider {
  const deepSeek = provider === 'deepseek';
  const url = deepSeek ? 'https://api.deepseek.com/responses' : 'https://api.openai.com/v1/responses';
  async function generate(instructions: string, content: unknown, name: string, schema: object, signal: AbortSignal) {
    const response = await request(url, {
      model, input: [{role: 'user', content}], instructions, max_output_tokens: 12288,
      ...(deepSeek ? {reasoning: {effort: 'low'}} : {store: false}),
      text: {format: {type: 'json_schema', name, schema, ...(deepSeek ? {} : {strict: true})}},
    }, signal) as {
      status?: string; output?: {type: string; content?: {type: string; text?: string}[]}[];
    };
    if (response.status !== 'completed' || !Array.isArray(response.output)) throw new InvalidPreview();
    const contents = response.output.flatMap(item => item.type === 'message' ? item.content ?? [] : []);
    return parse(contents.filter(part => part.type === 'output_text').map(part => part.text).join(''));
  }
  return {
    transcribe: (photo, signal) => generate(transcriptionInstruction,
      [{type: 'input_image', image_url: `data:image/jpeg;base64,${photo.toString('base64')}`, detail: 'high'}],
      'order_slip_transcript', transcriptSchema, signal),
    review: (sources, catalog, signal) => generate(reviewInstruction,
      JSON.stringify({sources, catalog}), 'order_slip_review', reviewSchema, signal),
  };
}

export async function createProvider(selection: ModelSelection, project: string, google: GoogleRequest,
  getSecretName: (provider: ResponsesProvider) => string, signal: AbortSignal,
  getVertexServing: () => VertexServing): Promise<SlipModelProvider> {
  if (selection.provider === 'vertex') {
    return vertexProvider(project, selection.model, async (url, body, signal, headers) =>
      readJson(await google(url, {method: 'POST', body: JSON.stringify(body), headers, signal})), getVertexServing());
  }
  const secretUrl = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${getSecretName(selection.provider)}/versions/latest:access`;
  const secret = await readJson(await google(secretUrl, {signal})) as {payload?: {data?: string}};
  const key = Buffer.from(secret.payload?.data ?? '', 'base64').toString().trim();
  if (!key) throw new Error('Missing slip model credential');
  return responsesProvider(selection.provider, selection.model, async (url, body, signal) => readJson(await fetch(url, {
    method: 'POST', redirect: 'error', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(body), signal,
  })));
}
