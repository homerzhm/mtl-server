import {createHash, randomUUID} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool} from 'pg';
import {validateInput, validateTiming, capacity} from './booking';

export type OrderCaller={uid:string;token:Record<string,unknown>};
export function requireOrderCaller(caller:OrderCaller|undefined):OrderCaller {
  if(!caller) throw new HttpsError('unauthenticated','Sign in');
  const firebase=caller.token.firebase as {sign_in_provider?:string}|undefined;
  if(!caller.uid||firebase?.sign_in_provider!=='google.com'||(caller.token.staff!==true&&caller.token.admin!==true))
    throw new HttpsError('permission-denied','Staff access required');
  return caller;
}
export class OrderCreationService {
  constructor(private readonly pool:Pool, private readonly now:()=>Date=()=>new Date(),
    private readonly number:()=>string=()=>randomUUID().replaceAll('-','').slice(0,6).toUpperCase().replaceAll('0','G').replaceAll('1','H')) {}
  async create(caller:OrderCaller|undefined, raw:unknown) {
    const actor=requireOrderCaller(caller), input=validateInput(raw);
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['order-create:'+input.id]);
      const prior=await db.query('SELECT actor_uid,payload_hash FROM order_creation_request WHERE id=$1',[input.id]);
      if(prior.rowCount) {
        if(prior.rows[0].actor_uid!==actor.uid||prior.rows[0].payload_hash!==hash) throw new HttpsError('already-exists','REQUEST_CONFLICT');
        await db.query('COMMIT');return {id:input.id};
      }
      const rollout=await db.query('SELECT enabled FROM order_booking_rollout WHERE id=true');
      if(!rollout.rows[0]?.enabled) throw new HttpsError('failed-precondition','BOOKING_NOT_ENABLED');
      const pickup=validateTiming(input,this.now());
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['roast:'+pickup.day]);
      // The narrowly granted helper takes row locks without granting table UPDATE.
      await db.query('SELECT public.lock_order_creation_sources($1::uuid[], $2::uuid)',
        [input.items.map(i=>i.productId),input.clientId]);
      const products=await db.query('SELECT id,name,price_cents,is_active,is_lechon,revision FROM product WHERE id=ANY($1::uuid[]) ORDER BY id',[input.items.map(i=>i.productId)]);
      let subtotal=0,pigs=0;
      for(const item of input.items) {
        const p=products.rows.find(p=>p.id===item.productId);
        if(!p||!p.is_active||p.revision!==item.expectedRevision) throw new HttpsError('failed-precondition','CATALOG_CHANGED');
        subtotal+=p.price_cents*item.quantity;if(p.is_lechon)pigs+=item.quantity;
      }
      if(!Number.isSafeInteger(subtotal)||subtotal<0||subtotal>2147483647||input.depositRequiredCents>subtotal||
        input.allocations.reduce((n,a)=>n+a.pigs,0)!==pigs) throw new HttpsError('invalid-argument','Check items, allocation and deposit');
      if(input.clientId) {
        const client=await db.query('SELECT id FROM client WHERE id=$1',[input.clientId]);
        if(!client.rowCount) throw new HttpsError('failed-precondition','CLIENT_UNAVAILABLE');
      }
      const booked=await db.query("SELECT a.block_minute,sum(a.pigs)::int AS pigs FROM order_roast_allocation a JOIN customer_order o ON o.id=a.order_id WHERE a.pickup_day=$1 AND o.status<>'CANCELLED' GROUP BY a.block_minute",[pickup.day]);
      for(const a of input.allocations) if(a.pigs+(booked.rows.find(b=>b.block_minute===a.minute)?.pigs??0)>capacity)
        throw new HttpsError('resource-exhausted','ROAST_CAPACITY');
      let inserted=false;
      for(let attempt=0;attempt<10;attempt++) {
        const result=await db.query(`INSERT INTO customer_order (id,order_number,client_id,contact_phone_number,scheduled_for,notes,subtotal_cents,item_count,deposit_required_cents,status,revision,created_at,updated_at,fulfillment_type,discount_cents,booking_managed)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONFIRMED',0,now(),now(),'PICKUP',0,true) ON CONFLICT(order_number) DO NOTHING RETURNING id`,
          [input.id,this.number(),input.clientId,input.contactPhoneNumber,input.scheduledFor,input.notes,subtotal,input.items.length,input.depositRequiredCents]);
        if(result.rowCount){inserted=true;break;}
      }
      if(!inserted)throw new HttpsError('aborted','Could not allocate an order number; retry');
      for(const item of input.items) {
        const p=products.rows.find(p=>p.id===item.productId)!;
        await db.query(`INSERT INTO order_item(id,order_id,product_id,product_name,catalog_unit_price_cents,unit_price_cents,quantity,is_lechon_snapshot,created_at)
          VALUES($1,$2,$3,$4,$5,$5,$6,$7,now())`,[item.id,input.id,p.id,p.name,p.price_cents,item.quantity,p.is_lechon]);
      }
      for(const a of input.allocations) await db.query('INSERT INTO order_roast_allocation(id,order_id,pickup_day,block_minute,pigs) VALUES($1,$2,$3,$4,$5)',[randomUUID(),input.id,pickup.day,a.minute,a.pigs]);
      await db.query('INSERT INTO order_creation_request(id,actor_uid,payload_hash) VALUES($1,$2,$3)',[input.id,actor.uid,hash]);
      await db.query(`INSERT INTO order_audit_event(id,order_id,action,actor_uid,occurred_at,order_revision,changes)
        VALUES($1,$2,'ORDER_CREATED',$3,now(),0,$4::jsonb)`,[randomUUID(),input.id,actor.uid,JSON.stringify({before:null,after:{...input,subtotalCents:subtotal,status:'CONFIRMED'}})]);
      // Time can advance while waiting for a lock; validate again before commit.
      validateTiming(input,this.now());
      await db.query('COMMIT');return {id:input.id};
    } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;} finally {db.release();}
  }
}
