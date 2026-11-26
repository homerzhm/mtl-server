export type Suggested<T> = {
  value: T | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  sourceLineIds: string[];
};

export type OrderSlipPreview = {
  version: 1;
  sources: {id: string; text: string}[];
  prefill: {
    items: {productId: Suggested<string>; quantity: Suggested<number>}[];
    pickup: {
      year: Suggested<number>; month: Suggested<number>; day: Suggested<number>;
      hour: Suggested<number>; minute: Suggested<number>; meridiem: Suggested<'AM' | 'PM'>;
    };
    contactName: Suggested<string>;
    contactPhoneNumber: Suggested<string>;
    notes: Suggested<string>;
    depositReceivedCents: Suggested<number>;
  };
  paperAmounts: {totalCents: Suggested<number>; payCents: Suggested<number>; balanceCents: Suggested<number>};
};

export type CatalogProduct = {id: string; name: string; chineseName: string | null};
export type SlipSource = OrderSlipPreview['sources'][number];
type JsonSchema = Record<string, unknown>;
const string = {type: 'string'};
const integer = {type: 'integer'};
export const schemaObject = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const array = (items: JsonSchema) => ({type: 'array', items});
const suggested = (value: JsonSchema) => schemaObject({
  value: {anyOf: [value, {type: 'null'}]},
  confidence: {type: 'string', enum: ['high', 'medium', 'low', 'unknown']},
  sourceLineIds: array(string),
});
const numeric = suggested(integer);
const sourceLines = array(schemaObject({id: string, text: string}));
export const transcriptSchema = schemaObject({
  sources: sourceLines,
});
export const reviewSchema = schemaObject({
  sourceCorrections: sourceLines,
  prefill: schemaObject({
    items: array(schemaObject({productId: suggested(string), quantity: numeric})),
    pickup: schemaObject({
      year: numeric, month: numeric, day: numeric, hour: numeric, minute: numeric,
      meridiem: suggested({type: 'string', enum: ['AM', 'PM']}),
    }),
    contactName: suggested(string), contactPhoneNumber: suggested(string),
    notes: suggested(string), depositReceivedCents: numeric,
  }),
  paperAmounts: schemaObject({totalCents: numeric, payCents: numeric, balanceCents: numeric}),
});

export class InvalidPreview extends Error {
  constructor() { super('Invalid slip preview'); }
}

export function exactObject(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))) return record;
}

function object(value: unknown, keys: string[]) {
  const result = exactObject(value, keys);
  if (!result) throw new InvalidPreview();
  return result;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InvalidPreview();
  return value;
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new InvalidPreview();
  return value.trim();
}

const int = (min: number, max: number) => (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new InvalidPreview();
  return value;
};

function phone(value: unknown): string {
  const text = boundedText(value, 32);
  const digits = text.replace(/[ ().-]/g, '');
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^\+[1-9]\d{1,14}$/.test(digits)) return digits;
  throw new InvalidPreview();
}

function validateSources(raw: unknown): SlipSource[] {
  const ids = new Set<string>();
  return list(raw, 40).map(rawSource => {
    const source = object(rawSource, ['id', 'text']);
    const id = boundedText(source.id, 32);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new InvalidPreview();
    ids.add(id);
    return {id, text: boundedText(source.text, 240)};
  });
}

export function validateTranscript(raw: unknown): SlipSource[] {
  return validateSources(object(raw, ['sources']).sources);
}

export function validatePreview(raw: unknown, catalog: CatalogProduct[]): OrderSlipPreview {
  const root = object(raw, ['version', 'sources', 'prefill', 'paperAmounts']);
  if (root.version !== 1) throw new InvalidPreview();
  const sources = validateSources(root.sources);
  const ids = new Set(sources.map(source => source.id));
  function field<T>(rawField: unknown, parse: (value: unknown) => T): Suggested<T> {
    const candidate = object(rawField, ['value', 'confidence', 'sourceLineIds']);
    const refs = list(candidate.sourceLineIds, 40).map(id => {
      if (typeof id !== 'string' || !ids.has(id)) throw new InvalidPreview();
      return id;
    });
    if (new Set(refs).size !== refs.length) throw new InvalidPreview();
    const confidence = candidate.confidence;
    if (candidate.value === null && confidence === 'unknown') return {value: null, confidence, sourceLineIds: refs};
    if (candidate.value === null || !refs.length || (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low')) {
      throw new InvalidPreview();
    }
    return {value: parse(candidate.value), confidence, sourceLineIds: refs};
  }
  const prefill = object(root.prefill, ['items', 'pickup', 'contactName', 'contactPhoneNumber', 'notes', 'depositReceivedCents']);
  const catalogIds = new Set(catalog.map(product => product.id));
  const items = list(prefill.items, 40).map(rawItem => {
    const item = object(rawItem, ['productId', 'quantity']);
    const productId = field(item.productId, value => {
      if (typeof value !== 'string' || !catalogIds.has(value.toLowerCase())) throw new InvalidPreview();
      return value.toLowerCase();
    });
    const quantity = field(item.quantity, int(1, 99));
    if (!productId.sourceLineIds.length && !quantity.sourceLineIds.length) throw new InvalidPreview();
    return {productId, quantity};
  });
  const date = object(prefill.pickup, ['year', 'month', 'day', 'hour', 'minute', 'meridiem']);
  const pickup = {
    year: field(date.year, int(1, 9999)), month: field(date.month, int(1, 12)), day: field(date.day, int(1, 31)),
    hour: field(date.hour, int(1, 12)), minute: field(date.minute, int(0, 59)),
    meridiem: field(date.meridiem, (value): 'AM' | 'PM' => {
      if (value === 'AM' || value === 'PM') return value;
      throw new InvalidPreview();
    }),
  };
  const {year, month, day} = pickup;
  if (month.value !== null && day.value !== null) {
    const date = new Date(0);
    date.setUTCFullYear(year.value ?? 2000, month.value - 1, day.value);
    if (date.getUTCMonth() !== month.value - 1) throw new InvalidPreview();
  }

  const money = int(0, 2147483647);
  const amounts = object(root.paperAmounts, ['totalCents', 'payCents', 'balanceCents']);
  const payCents = field(amounts.payCents, money);
  field(prefill.depositReceivedCents, money);
  return {
    version: 1, sources,
    prefill: {
      items, pickup,
      contactName: field(prefill.contactName, value => boundedText(value, 160)),
      contactPhoneNumber: field(prefill.contactPhoneNumber, phone),
      notes: field(prefill.notes, value => boundedText(value, 1000)),
      depositReceivedCents: payCents,
    },
    paperAmounts: {totalCents: field(amounts.totalCents, money), payCents, balanceCents: field(amounts.balanceCents, money)},
  };
}
