import {randomUUID} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {PoolClient} from 'pg';
import {blockHasStarted, integer, localParts, uuid, validateAllocations} from './booking';
import type {OrderCaller} from './permissions';

export function validateRoastAssignment(raw: unknown) {
  const value = raw as Record<string, unknown>;
  if (!value || typeof value!=='object' || value.action!=='ASSIGN_ROAST_BLOCK' || Array.isArray(value) || Object.keys(value).some(key =>
    !['action','requestId','id','expectedRevision','allocations'].includes(key)) ||
    typeof value.id!=='string' || !uuid.test(value.id) ||
    typeof value.requestId!=='string' || !uuid.test(value.requestId) ||
    !integer(value.expectedRevision,0,2147483646))
    throw new HttpsError('invalid-argument','ORDER_ASSIGNMENT_INVALID');
  const allocations=validateAllocations(value.allocations);
  if (!allocations.length) throw new HttpsError('invalid-argument','ORDER_ASSIGNMENT_INVALID');
  return {action:'ASSIGN_ROAST_BLOCK' as const,id:value.id.toLowerCase(),
    requestId:value.requestId.toLowerCase(),expectedRevision:value.expectedRevision,allocations};
}

export async function assignRoastBlock(
  db: PoolClient, actor: OrderCaller, input: ReturnType<typeof validateRoastAssignment>,
  order: {status:string; scheduled_for:Date|null; roast_block_needed_reason:string|null}
) {
  if (!['CONFIRMED','PAID'].includes(order.status) || !order.roast_block_needed_reason || !order.scheduled_for)
    throw new HttpsError('failed-precondition','ORDER_LOCKED');
  const {day}=localParts(order.scheduled_for);
  const settings=(await db.query("SELECT block_minutes FROM booking_settings WHERE id='default'")).rows[0];
  const groups=(await db.query(`SELECT i.capacity_group_id AS id,sum(i.quantity)::bigint AS quantity,g.archived,
    public.effective_block_capacity(g.id,$2,g.capacity_per_block) AS capacity
    FROM order_item i JOIN capacity_group g ON g.id=i.capacity_group_id
    WHERE i.order_id=$1 GROUP BY g.id,i.capacity_group_id`,[input.id,day])).rows;
  const booked=(await db.query(`SELECT a.group_id,a.block_minute,sum(a.quantity)::bigint AS quantity
    FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
    WHERE a.pickup_day=$1 AND o.status<>'CANCELLED' GROUP BY a.group_id,a.block_minute`,[day])).rows;
  const totals=new Map<string,number>();
  for (const allocation of input.allocations) {
    const {groupId,blockMinute,quantity}=allocation;
    const group=groups.find(group=>group.id===groupId);
    if (!group) throw new HttpsError('invalid-argument','ORDER_ASSIGNMENT_INVALID');
    if (!settings?.block_minutes.includes(blockMinute) || group.archived)
      throw new HttpsError('failed-precondition','BOOKING_CONFIGURATION_CHANGED');
    if (blockHasStarted(day,blockMinute,new Date()))
      throw new HttpsError('failed-precondition','PICKUP_EXPIRED');
    const used=booked.find(row=>row.group_id===groupId&&row.block_minute===blockMinute)?.quantity??'0';
    if (BigInt(used)+BigInt(quantity)>BigInt(group.capacity))
      throw new HttpsError('resource-exhausted','GROUP_CAPACITY');
    totals.set(groupId,(totals.get(groupId)??0)+quantity);
  }
  if (groups.some(group=>BigInt(totals.get(group.id)??0)!==BigInt(group.quantity)))
    throw new HttpsError('invalid-argument','ORDER_ASSIGNMENT_INVALID');
  await db.query('UPDATE customer_order SET roast_block_needed_reason=NULL,revision=revision+1,updated_at=now() WHERE id=$1',[input.id]);
  for (const allocation of input.allocations) {
    await db.query(`INSERT INTO order_capacity_allocation(id,order_id,pickup_day,group_id,block_minute,quantity)
      VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),input.id,day,allocation.groupId,allocation.blockMinute,allocation.quantity]);
  }
  await db.query(`INSERT INTO order_audit_event(id,order_id,action,actor_uid,occurred_at,order_revision,changes)
    VALUES($1,$2,'ROAST_BLOCK_ASSIGNED',$3,now(),$4,$5::jsonb)`,
    [randomUUID(),input.id,actor.uid,input.expectedRevision+1,JSON.stringify({
      before:{roastBlockNeededReason:order.roast_block_needed_reason},
      after:{roastBlockNeededReason:null,allocations:input.allocations}
    })]);
  if (input.allocations.some(allocation=>blockHasStarted(day,allocation.blockMinute,new Date())))
    throw new HttpsError('failed-precondition','PICKUP_EXPIRED');
}
