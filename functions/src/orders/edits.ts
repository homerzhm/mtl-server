import {createHash, randomUUID} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool} from 'pg';
import {lockCapacity} from './capacity';
import {blockHasStarted, integer, localParts, uuid, validateInput, validateTiming} from './booking';
import {requireOrderCaller, type OrderCaller} from './permissions';

export function validateEdit(raw: unknown) {
  const v = raw as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.action !== 'EDIT' ||
      Object.keys(v).some(k => !['action','requestId','id','expectedRevision','items','clientId','contactPhoneNumber','scheduledFor','expectedSettingsRevision','expectedGroups','allocations','notes','priceOverride'].includes(k)) ||
      typeof v.requestId !== 'string' || !uuid.test(v.requestId) || !integer(v.expectedRevision,0,2147483646) || !Array.isArray(v.items))
    throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
  let priceOverride: {amountCents: number | null} | undefined;
  if(Object.hasOwn(v,'priceOverride')) {
    const change=v.priceOverride as Record<string,unknown> | null;
    if(!change||typeof change!=='object'||Array.isArray(change)||Object.keys(change).length!==1||
        !Object.hasOwn(change,'amountCents')||(change.amountCents!==null&&!integer(change.amountCents)))
      throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
    priceOverride={amountCents:change.amountCents};
  }
  const revisions = new Map<string, number | null>();
  const items = v.items.map((i: Record<string, unknown>) => {
    if (!i || typeof i !== 'object' || (i.expectedRevision != null && !integer(i.expectedRevision)))
      throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
    revisions.set(String(i.id).toLowerCase(), i.expectedRevision == null ? null : Number(i.expectedRevision));
    return {...i,expectedRevision:i.expectedRevision ?? 0};
  });
  const input = validateInput({id:v.id,items,clientId:v.clientId,contactPhoneNumber:v.contactPhoneNumber,
    scheduledFor:v.scheduledFor,expectedSettingsRevision:v.expectedSettingsRevision,expectedGroups:v.expectedGroups,
    allocations:v.allocations,notes:v.notes,depositRequiredCents:0});
  return {action:'EDIT' as const,requestId:v.requestId.toLowerCase(),expectedRevision:Number(v.expectedRevision),
    ...input,items:input.items.map(i=>({...i,expectedRevision:revisions.get(i.id)!})),
    ...(priceOverride ? {priceOverride} : {})};
}

/** One atomic replacement. Native guards are relaxed only inside the restricted SQL routine. */
export class OrderEditService {
  constructor(private readonly pool: Pool, private readonly now:()=>Date=()=>new Date()) {}
  async edit(caller: OrderCaller | undefined, raw: unknown) {
    const actor=requireOrderCaller(caller), input=validateEdit(raw);
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['order-action:'+input.requestId]);
      const prior=(await db.query('SELECT actor_uid,payload_hash FROM order_action_request WHERE id=$1',[input.requestId])).rows[0];
      if(prior) {
        if(prior.actor_uid!==actor.uid||prior.payload_hash!==hash) throw new HttpsError('already-exists','REQUEST_CONFLICT');
        await db.query('COMMIT');return {id:input.id};
      }
      if(input.priceOverride && actor.token.admin!==true)
        throw new HttpsError('permission-denied','ORDER_PRICE_OVERRIDE_ADMIN');
      await lockCapacity(db);
      const order=(await db.query('SELECT * FROM customer_order WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
      if(!order||order.revision!==input.expectedRevision) throw new HttpsError('aborted','ORDER_CONFLICT');
      if(!['CONFIRMED','PAID'].includes(order.status)) throw new HttpsError('failed-precondition','ORDER_LOCKED');
      const saved=(await db.query('SELECT * FROM order_item WHERE order_id=$1 ORDER BY created_at,id',[input.id])).rows;
      const own=(await db.query('SELECT *,pickup_day::text AS pickup_day_key FROM order_capacity_allocation WHERE order_id=$1 ORDER BY group_id,block_minute',[input.id])).rows;
      await db.query('SELECT public.lock_order_creation_sources($1::uuid[],$2::uuid)',[input.items.map(i=>i.productId),input.clientId]);
      // Client changes always take their phone from the locked directory row. An unchanged
      // client may retain its original snapshot when that profile is no longer available.
      if(input.clientId) {
        const client=(await db.query('SELECT phone_number FROM client WHERE id=$1',[input.clientId])).rows[0];
        if((!client || client.phone_number!==input.contactPhoneNumber) && !(order.client_id===input.clientId && order.contact_phone_number===input.contactPhoneNumber)) throw new HttpsError('failed-precondition','CLIENT_UNAVAILABLE');
      } else if(input.contactPhoneNumber!==null) throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
      const products=(await db.query('SELECT * FROM product WHERE id=ANY($1::uuid[])',[input.items.map(i=>i.productId)])).rows;
      const required=new Map<string,number>();
      const lines=input.items.map(i=>{
        const old=saved.find(s=>s.id===i.id);
        if(old) {
          if(old.product_id!==i.productId||i.expectedRevision!==null) throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
          return {...old,quantity:i.quantity};
        }
        const product=products.find(p=>p.id===i.productId);
        if(saved.some(s=>s.product_id===i.productId)||!product||!product.is_active||product.revision!==i.expectedRevision)
          throw new HttpsError('failed-precondition','CATALOG_CHANGED');
        return {id:i.id,product_id:i.productId,product_name:product.name,catalog_unit_price_cents:product.price_cents,
          unit_price_cents:product.price_cents,quantity:i.quantity,capacity_group_id:product.capacity_group_id,
          capacity_group_name_snapshot:null,notes:null,created_at:null};
      });
      const subtotal=lines.reduce((n,i)=>n+i.quantity*i.unit_price_cents,0);
      if(!integer(subtotal)||subtotal<order.discount_cents) throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
      for(const line of lines) if(line.capacity_group_id) required.set(line.capacity_group_id,(required.get(line.capacity_group_id)??0)+line.quantity);
      const settings=(await db.query("SELECT * FROM booking_settings WHERE id='default'")).rows[0];
      if(!settings||settings.revision!==input.expectedSettingsRevision) throw new HttpsError('failed-precondition','BOOKING_CONFIGURATION_CHANGED');
      const pickup=localParts(new Date(input.scheduledFor));
      const groups=(await db.query('SELECT *,public.effective_block_capacity(id,$2,capacity_per_block) AS effective_capacity FROM capacity_group WHERE id=ANY($1::uuid[])',[Array.from(required.keys()),pickup.day])).rows;
      if(input.expectedGroups.length!==required.size||input.expectedGroups.some(g=>!required.has(g.id))) throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
      const samePickup=order.scheduled_for?.getTime()===Date.parse(input.scheduledFor);
      const savedDemand=new Map<string,number>();
      for(const line of saved) if(line.capacity_group_id)
        savedDemand.set(line.capacity_group_id,(savedDemand.get(line.capacity_group_id)??0)+line.quantity);
      const keepUnassigned=!!order.roast_block_needed_reason&&samePickup&&!input.allocations.length&&
        savedDemand.size===required.size&&[...required].every(([id,quantity])=>savedDemand.get(id)===quantity);
      for(const [id,quantity] of required) {
        const group=groups.find(g=>g.id===id);
        if(!group||group.revision!==input.expectedGroups.find(g=>g.id===id)?.expectedRevision)
          throw new HttpsError('failed-precondition','BOOKING_CONFIGURATION_CHANGED');
        if(!keepUnassigned&&input.allocations.filter(a=>a.groupId===id).reduce((n,a)=>n+a.quantity,0)!==quantity)
          throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
      }
      for(const line of lines) if(line.capacity_group_id&&!saved.some(s=>s.id===line.id)) {
        const group=groups.find(g=>g.id===line.capacity_group_id);
        if(group?.archived) throw new HttpsError('failed-precondition','CATALOG_CHANGED');
        line.capacity_group_name_snapshot=saved.find(s=>s.capacity_group_id===line.capacity_group_id)?.capacity_group_name_snapshot ?? group?.name;
      }
      const savedSlot=(allocation: typeof input.allocations[number])=>own.find(o=>
        o.pickup_day_key===pickup.day&&o.group_id===allocation.groupId&&o.block_minute===allocation.blockMinute);
      const retainsSavedSchedule=samePickup&&
        input.allocations.every(a=>a.quantity<=(savedSlot(a)?.quantity??0));
      const timingInput={...input,items:input.items.map(i=>({...i,expectedRevision:i.expectedRevision??0}))};
      const validateSchedule=()=>{
        if(retainsSavedSchedule) return;
        if(samePickup&&order.roast_block_needed_reason) {
          if(input.allocations.some(a=>blockHasStarted(pickup.day,a.blockMinute,this.now())))
            throw new HttpsError('failed-precondition','PICKUP_EXPIRED');
        } else validateTiming(timingInput,this.now());
      };
      validateSchedule();
      if(input.allocations.some(a=>!required.has(a.groupId)||(!retainsSavedSchedule&&!settings.block_minutes.includes(a.blockMinute))))
        throw new HttpsError('invalid-argument','ORDER_EDIT_INVALID');
      const booked=(await db.query(`SELECT a.group_id,a.block_minute,sum(a.quantity)::bigint quantity
        FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
        WHERE a.pickup_day=$1 AND o.status<>'CANCELLED' AND o.id<>$2 GROUP BY a.group_id,a.block_minute`,[pickup.day,input.id])).rows;
      for(const a of input.allocations) {
        const increases=a.quantity>(savedSlot(a)?.quantity??0);
        const group=groups.find(g=>g.id===a.groupId)!;
        const used=booked.find(b=>b.group_id===a.groupId&&b.block_minute===a.blockMinute)?.quantity??'0';
        if(increases&&(group.archived||BigInt(used)+BigInt(a.quantity)>BigInt(group.effective_capacity)))
          throw new HttpsError('resource-exhausted','GROUP_CAPACITY');
      }
      const net=(await db.query(`SELECT COALESCE((SELECT sum(amount_cents) FROM payment WHERE order_id=$1 AND status='SUCCEEDED'),0)
        -COALESCE((SELECT sum(r.amount_cents) FROM refund r JOIN payment p ON p.id=r.payment_id WHERE p.order_id=$1 AND r.status='SUCCEEDED'),0) net`,[input.id])).rows[0].net;
      const override=input.priceOverride ? input.priceOverride.amountCents : order.price_override_cents;
      const total=override??(subtotal-order.discount_cents);
      const status=order.status==='PAID'&&BigInt(net)<BigInt(total)?'CONFIRMED':order.status;
      const after={...order,subtotal_cents:subtotal,item_count:lines.length,scheduled_for:input.scheduledFor,
        client_id:input.clientId,contact_phone_number:input.contactPhoneNumber,notes:input.notes,
        roast_block_needed_reason:keepUnassigned?order.roast_block_needed_reason:null,
        price_override_cents:override,
        final_total_cents:override===null&&order.final_total_cents===null?null:total,status,revision:order.revision+1};
      // The SQL routine owns the temporary privileged context, updates and exact-total checks.
      await db.query('SELECT public.apply_native_order_edit($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',
        [input.id,input.expectedRevision,JSON.stringify(after),JSON.stringify(lines),JSON.stringify(input.allocations)]);
      if(input.priceOverride) {
        const stored=(await db.query('SELECT price_override_cents FROM customer_order WHERE id=$1',[input.id])).rows[0];
        if(stored?.price_override_cents!==override) throw new Error('Order edit price override migration required');
      }
      await db.query(`INSERT INTO order_audit_event(id,order_id,action,actor_uid,occurred_at,order_revision,changes)
        VALUES($1,$2,'ORDER_EDITED',$3,now(),$4,$5::jsonb)`,[randomUUID(),input.id,actor.uid,after.revision,
        JSON.stringify({before:{...order,items:saved,allocations:own},after:{...after,items:lines,allocations:input.allocations}})]);
      await db.query('INSERT INTO order_action_request(id,actor_uid,payload_hash) VALUES($1,$2,$3)',[input.requestId,actor.uid,hash]);
      validateSchedule();
      await db.query('COMMIT');return {id:input.id};
    } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;} finally {db.release();}
  }
}
