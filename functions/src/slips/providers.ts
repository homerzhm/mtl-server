import {GoogleRequest, ProviderRequest, readJson} from './transport';
import {catalogTool, ModelSelection, previewSchema, ProviderTurn, SlipModelProvider, systemInstruction} from './model';
import {InvalidPreview} from './preview';

type Part = {text?: string; thought?: boolean; functionCall?: {name: string; args: unknown; id?: string}};
type OpenAIItem = {
  type: string; name?: string; call_id?: string; arguments?: string;
  content?: {type: string; text?: string}[];
};

const finishInstruction = 'Return the final slip preview now using the response schema.';

function parse(text: string | undefined): unknown {
  if (!text) throw new InvalidPreview();
  try { return JSON.parse(text); }
  catch { throw new InvalidPreview(); }
}

export function vertexProvider(project: string, model: string, request: ProviderRequest): SlipModelProvider {
  const region = 'northamerica-northeast1';
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
  return {start(photo, signal) {
    const history: {role: string; parts: unknown[]}[] = [{
      role: 'user', parts: [{inlineData: {mimeType: 'image/jpeg', data: photo.toString('base64')}}],
    }];
    let pending: NonNullable<Part['functionCall']>[] = [];
    return {async turn({final, results}): Promise<ProviderTurn> {
      if (pending.length) {
        if (pending.length !== results.length) throw new InvalidPreview();
        history.push({role: 'user', parts: pending.map((call, index) => ({
          functionResponse: {name: call.name, ...(call.id ? {id: call.id} : {}), response: {matches: results[index]}},
        }))});
      }
      if (final) history.push({role: 'user', parts: [{text: finishInstruction}]});
      const response = await request(url, {
        systemInstruction: {parts: [{text: systemInstruction}]},
        contents: history,
        ...(final ? {} : {tools: [{functionDeclarations: [{name: catalogTool.name, description: catalogTool.description,
          parametersJsonSchema: catalogTool.parameters}]}]}),
        generationConfig: {
          maxOutputTokens: 12288,
          ...(final ? {responseMimeType: 'application/json', responseJsonSchema: previewSchema} : {}),
        },
      }, signal, {'X-Vertex-AI-LLM-Request-Type': 'dedicated'}) as {
        candidates?: {finishReason?: string; content?: {role: string; parts: Part[]}}[];
      };
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new InvalidPreview();
      const parts = candidate.content.parts;
      // Preserve provider-specific parts and thought signatures in continuation turns.
      history.push(candidate.content);
      pending = parts.flatMap(part => part.functionCall ? [part.functionCall] : []);
      return {
        calls: pending.map(call => ({name: call.name, args: call.args})),
        ...(final && !pending.length ? {final: parse(parts.filter(part => !part.thought).map(part => part.text ?? '').join(''))} : {}),
      };
    }};
  }};
}

export function openAIProvider(model: string, request: ProviderRequest): SlipModelProvider {
  return {start(photo, signal) {
    const input: unknown[] = [{
      role: 'user', content: [{type: 'input_image', image_url: `data:image/jpeg;base64,${photo.toString('base64')}`, detail: 'high'}],
    }];
    let pending: OpenAIItem[] = [];
    return {async turn({final, results}): Promise<ProviderTurn> {
      if (pending.length !== results.length) throw new InvalidPreview();
      input.push(...pending.map((call, index) => ({
        type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({matches: results[index]}),
      })));
      if (final) input.push({role: 'user', content: finishInstruction});
      const response = await request('https://api.openai.com/v1/responses', {
        model, input, instructions: systemInstruction, store: false, max_output_tokens: 12288,
        include: ['reasoning.encrypted_content'],
        ...(final ? {text: {format: {type: 'json_schema', name: 'order_slip_preview', strict: true, schema: previewSchema}}}
          : {tools: [{type: 'function', ...catalogTool, strict: true}]}),
      }, signal) as {status?: string; output?: OpenAIItem[]};
      if (response.status !== 'completed' || !Array.isArray(response.output)) throw new InvalidPreview();
      input.push(...response.output);
      pending = response.output.filter(item => item.type === 'function_call');
      const calls = pending.map(call => {
        if (!call.call_id || !call.name) throw new InvalidPreview();
        return {name: call.name, args: parse(call.arguments)};
      });
      const contents = response.output.flatMap(item => item.type === 'message' ? item.content ?? [] : []);
      return {
        calls,
        ...(final && !calls.length ? {final: parse(contents.filter(part => part.type === 'output_text').map(part => part.text).join(''))} : {}),
      };
    }};
  }};
}

export async function createProvider(selection: ModelSelection, project: string, google: GoogleRequest,
  secretName: string, signal: AbortSignal): Promise<SlipModelProvider> {
  if (selection.provider === 'vertex') {
    return vertexProvider(project, selection.model, async (url, body, signal, headers) =>
      readJson(await google(url, {method: 'POST', body: JSON.stringify(body), headers, signal})));
  }
  const secretUrl = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretName}/versions/latest:access`;
  const secret = await readJson(await google(secretUrl, {signal})) as {payload?: {data?: string}};
  const key = Buffer.from(secret.payload?.data ?? '', 'base64').toString().trim();
  if (!key) throw new Error('Missing slip model credential');
  return openAIProvider(selection.model, async (url, body, signal) => readJson(await fetch(url, {
    method: 'POST', redirect: 'error', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(body), signal,
  })));
}
