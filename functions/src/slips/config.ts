import {defineString} from 'firebase-functions/params';
import {ModelSelection} from './model';

export const slipsRegion = defineString('SLIPS_REGION', {default: 'northamerica-northeast1'});
export const slipsIdentity = defineString('SLIPS_RUNTIME_SERVICE_ACCOUNT');
export const slipsInstance = defineString('SLIPS_SQL_INSTANCE');
export const slipsUser = defineString('SLIPS_SQL_USER');
export const slipsDatabase = defineString('SLIPS_SQL_DATABASE', {default: 'restaurant'});
export const slipsBucket = defineString('SLIPS_BUCKET');
export const slipsProvider = defineString('SLIPS_LLM_PROVIDER', {default: 'vertex'});
export const slipsOpenAIModel = defineString('SLIPS_OPENAI_MODEL', {default: 'gpt-5.4-mini'});
export const slipsOpenAISecret = defineString('SLIPS_OPENAI_SECRET', {default: 'mtl-slips-openai'});

export function selectedModel(): ModelSelection {
  const provider = slipsProvider.value();
  if (provider === 'vertex') return {provider, model: 'gemini-3.8-flash'};
  const model = slipsOpenAIModel.value();
  if (provider !== 'openai' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(model)) throw new Error('Invalid slip model configuration');
  return {provider, model};
}

export function isEmulator(): boolean {
  return Boolean(process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    (process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT)?.startsWith('demo-'));
}
