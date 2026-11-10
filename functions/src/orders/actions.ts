import {createHash, randomUUID} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool} from 'pg';
import {requireOrderCaller, type OrderCaller} from './service';

export type OrderAction = {requestId: string; id: string; expectedRevision: number;
  action: 'PAYMENT' | 'PAID' | 'PICKUP'; amountCents: number | null};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateAction(raw: unknown): OrderAction {
  const v = raw as Record<string, unknown> | null;
  const invalid = () => new HttpsError('invalid-argument', 'ORDER_ACTION_INVALID');
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).some(k => !['requestId','id','expectedRevision','action','amountCents'].includes(k)) ||
      typeof v.requestId !== 'string' || !uuid.test(v.requestId) || typeof v.id !== 'string' || !uuid.test(v.id) ||
      !Number.isInteger(v.expectedRevision) || Number(v.expectedRevision) < 0 || Number(v.expectedRevision) >= 2147483647 ||
      typeof v.action !== 'string' || !['PAYMENT','PAID','PICKUP'].includes(v.action)) throw invalid();
  const amount = v.amountCents ?? null;
  if (v.action === 'PAYMENT' ? !Number.isInteger(amount) || Number(amount) <= 0 || Number(amount) > 2147483647 : amount !== null) throw invalid();
  return {requestId:v.requestId.toLowerCase(),id:v.id.toLowerCase(),expectedRevision:Number(v.expectedRevision),
    action:v.action as OrderAction['action'],amountCents:amount as number | null};
}

export class OrderActionService {
  constructor(private readonly pool: Pool) {}
  async perform(caller: OrderCaller | undefined, raw: unknown) {
    const actor = requireOrderCaller(caller), input = validateAction(raw);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['order-action:'+input.requestId]);
      const prior = await db.query('SELECT actor_uid,payload_hash FROM order_action_request WHERE id=$1',[input.requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].actor_uid !== actor.uid || prior.rows[0].payload_hash !== hash)
          throw new HttpsError('already-exists','REQUEST_CONFLICT');
        await db.query('COMMIT'); return {id:input.id};
      }
      const result = await db.query('SELECT * FROM customer_order WHERE id=$1 FOR UPDATE',[input.id]);
      const order = result.rows[0];
      if (!order || order.revision !== input.expectedRevision) throw new HttpsError('aborted','ORDER_CONFLICT');
      const before = {status:order.status,finalTotalCents:order.final_total_cents,
        completedAt:order.completed_at?.toISOString() ?? null};
      const revision = order.revision + 1;
      let payment: unknown = null;
      if (input.action === 'PAYMENT') {
        if (order.status !== 'CONFIRMED') throw new HttpsError('failed-precondition','ORDER_LOCKED');
        // Every ledger writer locks/increments the parent revision before inserting.
        await db.query('UPDATE customer_order SET revision=$2,updated_at=now() WHERE id=$1',[input.id,revision]);
        const receipt = await db.query(`INSERT INTO payment(id,order_id,amount_cents,method,status,received_at,created_at)
          VALUES($1,$2,$3,'CASH','SUCCEEDED',now(),now()) RETURNING id,amount_cents,received_at`,[input.requestId,input.id,input.amountCents]);
        const saved = receipt.rows[0];
        payment = {id:saved.id,amountCents:saved.amount_cents,receivedAt:saved.received_at.toISOString()};
      } else if (input.action === 'PAID') {
        if (order.status !== 'CONFIRMED') throw new HttpsError('failed-precondition','ORDER_LOCKED');
        const totals = await db.query(`SELECT
          COALESCE((SELECT sum(amount_cents) FROM payment WHERE order_id=$1 AND status='SUCCEEDED'),0)
          - COALESCE((SELECT sum(r.amount_cents) FROM refund r JOIN payment p ON p.id=r.payment_id
            WHERE p.order_id=$1 AND r.status='SUCCEEDED'),0) AS net`,[input.id]);
        const total = order.subtotal_cents - order.discount_cents;
        if (order.final_total_cents !== null && order.final_total_cents !== total)
          throw new HttpsError('failed-precondition','ORDER_TOTAL_REVIEW');
        if (BigInt(totals.rows[0].net) < BigInt(total)) throw new HttpsError('failed-precondition','ORDER_BALANCE_DUE');
        await db.query(`UPDATE customer_order SET status='PAID',final_total_cents=$3,revision=$2,updated_at=now() WHERE id=$1`,[input.id,revision,total]);
      } else {
        if (order.status !== 'PAID') throw new HttpsError('failed-precondition','ORDER_NOT_PAID');
        await db.query(`UPDATE customer_order SET status='COMPLETED',completed_at=now(),revision=$2,updated_at=now() WHERE id=$1`,[input.id,revision]);
      }
      const after = (await db.query('SELECT status,final_total_cents,completed_at FROM customer_order WHERE id=$1',[input.id])).rows[0];
      await db.query(`INSERT INTO order_audit_event(id,order_id,action,actor_uid,occurred_at,order_revision,changes)
        VALUES($1,$2,$3,$4,now(),$5,$6::jsonb)`,[randomUUID(),input.id,
        {PAYMENT:'PAYMENT_RECEIVED',PAID:'ORDER_MARKED_PAID',PICKUP:'ORDER_COMPLETED'}[input.action],actor.uid,revision,
        JSON.stringify({before,after:{status:after.status,finalTotalCents:after.final_total_cents,
          completedAt:after.completed_at?.toISOString() ?? null,payment}})]);
      await db.query('INSERT INTO order_action_request(id,actor_uid,payload_hash) VALUES($1,$2,$3)',[input.requestId,actor.uid,hash]);
      await db.query('COMMIT'); return {id:input.id};
    } catch (error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { db.release(); }
  }
}
