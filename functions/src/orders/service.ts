import {createHash, randomUUID} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool} from 'pg';
import {lockCapacity} from './capacity';
import {validateInput, validateTiming} from './booking';

import {requireOrderCaller, type OrderCaller} from './permissions';
export {requireOrderCaller, type OrderCaller} from './permissions';

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
      const pickup=validateTiming(input,this.now());
      await lockCapacity(db);
      const settings=(await db.query("SELECT block_minutes,revision FROM booking_settings WHERE id='default'")).rows[0];
      if(!settings||settings.revision!==input.expectedSettingsRevision) throw new HttpsError('failed-precondition','BOOKING_CONFIGURATION_CHANGED');
      // The narrowly granted helper takes row locks without granting table UPDATE.
      await db.query('SELECT public.lock_order_creation_sources($1::uuid[], $2::uuid)',
        [input.items.map(i=>i.productId),input.clientId]);
      const products=await db.query('SELECT id,name,price_cents,is_active,capacity_group_id,revision FROM product WHERE id=ANY($1::uuid[]) ORDER BY id',[input.items.map(i=>i.productId)]);
      let subtotal=0;
      const required=new Map<string,number>();
      for(const item of input.items) {
        const p=products.rows.find(p=>p.id===item.productId);
        if(!p||!p.is_active||p.revision!==item.expectedRevision) throw new HttpsError('failed-precondition','CATALOG_CHANGED');
        subtotal+=p.price_cents*item.quantity;
        if(p.capacity_group_id) required.set(p.capacity_group_id,(required.get(p.capacity_group_id)??0)+item.quantity);
      }
      if(!Number.isSafeInteger(subtotal)||subtotal<0||subtotal>2147483647||input.depositRequiredCents>subtotal) throw new HttpsError('invalid-argument','Check items, allocation and deposit');
      if(input.clientId) {
        const client=await db.query('SELECT id FROM client WHERE id=$1',[input.clientId]);
        if(!client.rowCount) throw new HttpsError('failed-precondition','CLIENT_UNAVAILABLE');
      }
      const groups=(await db.query('SELECT id,name,capacity_per_block,archived,revision FROM capacity_group WHERE id=ANY($1::uuid[])',[Array.from(required.keys())])).rows;
      if(input.expectedGroups.length!==required.size||input.expectedGroups.some(g=>!required.has(g.id)))
        throw new HttpsError('invalid-argument','Check expected groups');
      for(const [id,quantity] of required) {
        const group=groups.find(g=>g.id===id);
        if(!group||group.archived||group.revision!==input.expectedGroups.find(g=>g.id===id)?.expectedRevision)
          throw new HttpsError('failed-precondition','BOOKING_CONFIGURATION_CHANGED');
        if(input.allocations.filter(a=>a.groupId===id).reduce((n,a)=>n+a.quantity,0)!==quantity)
          throw new HttpsError('invalid-argument','Check group allocations');
      }
      if(input.allocations.some(a=>!required.has(a.groupId)||!settings.block_minutes.includes(a.blockMinute)))
        throw new HttpsError('invalid-argument','Check group allocations');
      const booked=await db.query("SELECT a.group_id,a.block_minute,sum(a.quantity)::bigint AS quantity FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id WHERE a.pickup_day=$1 AND o.status<>'CANCELLED' GROUP BY a.group_id,a.block_minute",[pickup.day]);
      for(const a of input.allocations) {
        const used=booked.rows.find(b=>b.group_id===a.groupId&&b.block_minute===a.blockMinute)?.quantity??'0';
        if(BigInt(used)+BigInt(a.quantity)>BigInt(groups.find(g=>g.id===a.groupId)!.capacity_per_block))
          throw new HttpsError('resource-exhausted','GROUP_CAPACITY');
      }
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
        await db.query(`INSERT INTO order_item(id,order_id,product_id,product_name,catalog_unit_price_cents,unit_price_cents,quantity,capacity_group_id,capacity_group_name_snapshot,created_at)
          VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,now())`,[item.id,input.id,p.id,p.name,p.price_cents,item.quantity,p.capacity_group_id,groups.find(g=>g.id===p.capacity_group_id)?.name??null]);
      }
      for(const a of input.allocations) await db.query('INSERT INTO order_capacity_allocation(id,order_id,pickup_day,group_id,block_minute,quantity) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),input.id,pickup.day,a.groupId,a.blockMinute,a.quantity]);
      await db.query('INSERT INTO order_creation_request(id,actor_uid,payload_hash) VALUES($1,$2,$3)',[input.id,actor.uid,hash]);
      await db.query(`INSERT INTO order_audit_event(id,order_id,action,actor_uid,occurred_at,order_revision,changes)
        VALUES($1,$2,'ORDER_CREATED',$3,now(),0,$4::jsonb)`,[randomUUID(),input.id,actor.uid,JSON.stringify({before:null,after:{...input,subtotalCents:subtotal,status:'CONFIRMED'}})]);
      // Time can advance while waiting for a lock; validate again before commit.
      validateTiming(input,this.now());
      await db.query('COMMIT');return {id:input.id};
    } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;} finally {db.release();}
  }
}
