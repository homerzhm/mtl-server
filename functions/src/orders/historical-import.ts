import {createHash, randomUUID} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool, PoolClient} from 'pg';
import {integer, uuid} from './booking';
import {lockCapacity} from './capacity';
import type {OrderCaller} from './permissions';

export function requireHistoricalImportAdmin(caller: OrderCaller | undefined): OrderCaller {
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in');
  const firebase = caller.token.firebase as {sign_in_provider?: string} | undefined;
  if (!caller.uid || firebase?.sign_in_provider !== 'google.com' || caller.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
  return caller;
}

function invalid(): never {
  throw new HttpsError('invalid-argument', 'Check the historical order fields');
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) invalid();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) invalid();
  return value.toLowerCase();
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
      value.startsWith('0000-') || !Number.isFinite(Date.parse(value))) invalid();
  const normalized = new Date(value).toISOString();
  if (normalized !== value && normalized.replace('.000Z', 'Z') !== value) invalid();
  return normalized;
}

function phoneNumber(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') invalid();
  const normalized = /^[0-9]{10}$/.test(value) ? '+1' + value : value;
  if (!/^\+[1-9][0-9]{1,14}$/.test(normalized)) invalid();
  return normalized;
}

export function parseHistoricalOrder(value: unknown) {
  const input = record(value, ['id', 'items', 'clientId', 'contactPhoneNumber', 'notes',
    'scheduledFor', 'createdAt', 'payments']);
  const id = identifier(input.id);
  const scheduledFor = instant(input.scheduledFor);
  const createdAt = input.createdAt == null ? scheduledFor : instant(input.createdAt);
  const notes = input.notes ?? null;
  if (createdAt > scheduledFor || (notes !== null && (typeof notes !== 'string' || notes.length > 10000)) ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100 ||
      !Array.isArray(input.payments) || input.payments.length > 100) invalid();

  const itemIds = new Set<string>();
  const productIds = new Set<string>();
  const items = input.items.map(value => {
    const item = record(value, ['id', 'productId', 'quantity', 'expectedRevision']);
    const itemId = identifier(item.id);
    const productId = identifier(item.productId);
    if (itemIds.has(itemId) || productIds.has(productId) || !integer(item.quantity, 1, 99) ||
        !integer(item.expectedRevision)) invalid();
    itemIds.add(itemId);
    productIds.add(productId);
    return {id: itemId, productId, quantity: item.quantity, expectedRevision: item.expectedRevision};
  }).sort((a, b) => a.id.localeCompare(b.id));

  const payments = input.payments.map(value => {
    const payment = record(value, ['amountCents', 'receivedAt']);
    const receivedAt = payment.receivedAt == null ? scheduledFor : instant(payment.receivedAt);
    if (!integer(payment.amountCents, 1) || receivedAt > scheduledFor) invalid();
    return {amountCents: payment.amountCents, receivedAt};
  }).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  return {id, scheduledFor, createdAt, notes, items, payments,
    clientId: input.clientId == null ? null : identifier(input.clientId),
    contactPhoneNumber: phoneNumber(input.contactPhoneNumber)};
}

type HistoricalOrder = ReturnType<typeof parseHistoricalOrder>;
type Product = {id: string; name: string; price_cents: number; revision: number};
type Snapshot = {status: 'CONFIRMED' | 'PAID' | 'COMPLETED'; finalTotalCents: number | null;
  completedAt: string | null};

async function audit(db: PoolClient, orderId: string, actorUid: string, revision: number,
  action: string, occurredAt: string, changes: object) {
  await db.query(`INSERT INTO order_audit_event
    (id,order_id,action,actor_uid,occurred_at,order_revision,changes)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
  [randomUUID(), orderId, action, actorUid, occurredAt, revision, JSON.stringify(changes)]);
}

async function insertOrder(db: PoolClient, input: HistoricalOrder, subtotal: number) {
  // Use the same database-generated order number and retry only number collisions.
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await db.query<{updated_at: Date}>(`INSERT INTO customer_order
      (id,client_id,contact_phone_number,scheduled_for,notes,subtotal_cents,item_count,
        deposit_required_cents,status,revision,created_at,updated_at,fulfillment_type,discount_cents,booking_managed)
      VALUES($1,$2,$3,$4,$5,$6,$7,0,'CONFIRMED',0,$8,clock_timestamp(),'PICKUP',0,true)
      ON CONFLICT(order_number) DO NOTHING RETURNING updated_at`,
    [input.id, input.clientId, input.contactPhoneNumber, input.scheduledFor, input.notes,
      subtotal, input.items.length, input.createdAt]);
    if (result.rowCount) return result.rows[0].updated_at.toISOString();
  }
  throw new HttpsError('aborted', 'Could not allocate an order number; retry');
}

export class HistoricalOrderImportService {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  async importOrder(caller: OrderCaller | undefined, value: unknown) {
    const actor = requireHistoricalImportAdmin(caller);
    const input = parseHistoricalOrder(value);
    const hash = createHash('sha256').update('historical-order-v1\0').update(JSON.stringify(input)).digest('hex');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Share the UUID namespace and serialize with createStaffOrder.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['order-create:' + input.id]);
      const prior = (await db.query('SELECT actor_uid,payload_hash FROM order_creation_request WHERE id=$1',
        [input.id])).rows[0];
      if (prior) {
        if (prior.actor_uid !== actor.uid || prior.payload_hash !== hash) {
          throw new HttpsError('already-exists', 'REQUEST_CONFLICT');
        }
        await db.query('COMMIT');
        return {id: input.id};
      }
      if (Date.parse(input.scheduledFor) >= this.now().getTime()) {
        throw new HttpsError('failed-precondition', 'HISTORICAL_PICKUP_REQUIRED');
      }

      // The order/item statement triggers take this same lock. Acquire it before source row locks.
      await lockCapacity(db);
      if ((await db.query('SELECT id FROM customer_order WHERE id=$1', [input.id])).rowCount) {
        throw new HttpsError('already-exists', 'REQUEST_CONFLICT');
      }
      const productIds = input.items.map(item => item.productId);
      await db.query('SELECT public.lock_order_creation_sources($1::uuid[], $2::uuid)', [productIds, input.clientId]);
      const products = await db.query<Product>('SELECT id,name,price_cents,revision FROM product WHERE id=ANY($1::uuid[])',
        [productIds]);
      const byId = new Map(products.rows.map(product => [product.id, product]));
      let subtotal = 0;
      const lines = input.items.map(item => {
        const product = byId.get(item.productId);
        if (!product) throw new HttpsError('failed-precondition', 'PRODUCT_UNAVAILABLE');
        if (product.revision !== item.expectedRevision) {
          throw new HttpsError('failed-precondition', 'CATALOG_CHANGED');
        }
        subtotal += product.price_cents * item.quantity;
        return {item, product};
      });
      if (!integer(subtotal)) invalid();
      if (input.clientId && !(await db.query('SELECT id FROM client WHERE id=$1', [input.clientId])).rowCount) {
        throw new HttpsError('failed-precondition', 'CLIENT_UNAVAILABLE');
      }

      const importedAt = await insertOrder(db, input, subtotal);
      for (const {item, product} of lines) {
        await db.query(`INSERT INTO order_item
          (id,order_id,product_id,product_name,catalog_unit_price_cents,unit_price_cents,quantity,created_at)
          VALUES($1,$2,$3,$4,$5,$5,$6,$7)`,
        [item.id, input.id, product.id, product.name, product.price_cents, item.quantity, input.createdAt]);
      }
      const confirmed: Snapshot = {status: 'CONFIRMED', finalTotalCents: null, completedAt: null};
      await audit(db, input.id, actor.uid, 0, 'ORDER_CREATED', input.createdAt, {
        historicalImport: {importedAt}, before: null,
        after: {...confirmed, subtotalCents: subtotal, clientId: input.clientId,
          contactPhoneNumber: input.contactPhoneNumber, scheduledFor: input.scheduledFor, notes: input.notes,
          items: lines.map(({item, product}) => ({id: item.id, productId: product.id,
            productName: product.name, unitPriceCents: product.price_cents, quantity: item.quantity}))},
      });

      let revision = 0;
      for (const payment of input.payments) {
        await db.query('UPDATE customer_order SET revision=$2 WHERE id=$1', [input.id, ++revision]);
        const paymentId = randomUUID();
        await db.query(`INSERT INTO payment(id,order_id,amount_cents,method,status,received_at,created_at)
          VALUES($1,$2,$3,'CASH','SUCCEEDED',$4,$4)`, [paymentId, input.id, payment.amountCents, payment.receivedAt]);
        await audit(db, input.id, actor.uid, revision, 'PAYMENT_RECEIVED', payment.receivedAt,
          {before: confirmed, after: {...confirmed, payment: {id: paymentId, ...payment}}});
      }

      const paid: Snapshot = {...confirmed, status: 'PAID', finalTotalCents: subtotal};
      await db.query("UPDATE customer_order SET revision=$2,status='PAID',final_total_cents=$3 WHERE id=$1",
        [input.id, ++revision, subtotal]);
      await audit(db, input.id, actor.uid, revision, 'ORDER_MARKED_PAID', input.scheduledFor,
        {before: confirmed, after: paid});
      await db.query("UPDATE customer_order SET revision=$2,status='COMPLETED',completed_at=$3 WHERE id=$1",
        [input.id, ++revision, input.scheduledFor]);
      await audit(db, input.id, actor.uid, revision, 'ORDER_COMPLETED', input.scheduledFor,
        {before: paid, after: {...paid, status: 'COMPLETED', completedAt: input.scheduledFor}});
      await db.query('INSERT INTO order_creation_request(id,actor_uid,payload_hash) VALUES($1,$2,$3)',
        [input.id, actor.uid, hash]);
      await db.query('COMMIT');
      return {id: input.id};
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
