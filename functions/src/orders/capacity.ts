import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool, PoolClient} from 'pg';
import {integer, uuid} from './booking';
import {requireOrderCaller, type OrderCaller} from './permissions';

// Statement triggers use this same lock BEFORE taking any row locks. This small
// restaurant serializes capacity writers globally to make config edits atomic too.
export async function lockCapacity(db: PoolClient) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('booking-capacity',0))");
}
export function requireBookingAdmin(caller: OrderCaller | undefined) {
  const actor=requireOrderCaller(caller);
  if(actor.token.staff!==true||actor.token.admin!==true) throw new HttpsError('permission-denied','Staff and Admin access required');
  return actor;
}
type ConfigurationChange =
  {action:'UPDATE_SETTINGS'; expectedRevision:number; blockMinutes:number[]} |
  {action:'CREATE_GROUP'; id:string; code:string; name:string; capacityPerBlock:number} |
  {action:'UPDATE_GROUP'; id:string; expectedRevision:number; name:string; capacityPerBlock:number; archived:boolean};
export function validateConfiguration(raw:unknown):ConfigurationChange {
  const fail=():never=>{throw new HttpsError('invalid-argument','BOOKING_CONFIGURATION_INVALID');};
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) return fail();
  const v=raw as Record<string,unknown>;
  const allowed=v.action==='UPDATE_SETTINGS'?['action','expectedRevision','blockMinutes']:
    v.action==='CREATE_GROUP'?['action','id','code','name','capacityPerBlock']:
    v.action==='UPDATE_GROUP'?['action','id','expectedRevision','name','capacityPerBlock','archived']:[];
  if(!allowed.length||Object.keys(v).some(k=>!allowed.includes(k))) return fail();
  if(v.action!=='CREATE_GROUP'&&!integer(v.expectedRevision,0,2147483646)) return fail();
  if(v.action==='UPDATE_SETTINGS') {
    if(!Array.isArray(v.blockMinutes)||!v.blockMinutes.length||v.blockMinutes.length>96||
      v.blockMinutes.some(m=>!integer(m,0,1439)||m%15!==0)||new Set(v.blockMinutes).size!==v.blockMinutes.length) return fail();
    return {action:v.action,expectedRevision:Number(v.expectedRevision),blockMinutes:[...v.blockMinutes].sort((a,b)=>a-b)};
  }
  if(typeof v.id!=='string'||!uuid.test(v.id)||typeof v.name!=='string'||!v.name.trim()||v.name!==v.name.trim()||v.name.length>200||!integer(v.capacityPerBlock,1)) return fail();
  if(v.action==='CREATE_GROUP') {
    if(typeof v.code!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(v.code)) return fail();
    return {action:v.action,id:v.id.toLowerCase(),code:v.code,name:v.name,capacityPerBlock:v.capacityPerBlock};
  }
  if(typeof v.archived!=='boolean') return fail();
  return {action:'UPDATE_GROUP',id:v.id.toLowerCase(),expectedRevision:Number(v.expectedRevision),name:v.name,capacityPerBlock:v.capacityPerBlock,archived:v.archived};
}
function configurationError(error:unknown):never {
  const message=(error as Error).message;
  for(const code of ['BOOKING_BLOCK_IN_USE','GROUP_CAPACITY_IN_USE','GROUP_HAS_PRODUCTS'])
    if(message===code) throw new HttpsError('failed-precondition',code);
  if((error as {code?:string}).code==='23505') throw new HttpsError('already-exists','GROUP_EXISTS');
  throw error;
}
export class BookingConfigurationService {
  constructor(private readonly pool:Pool) {}
  async change(caller:OrderCaller|undefined,raw:unknown) {
    const actor=requireBookingAdmin(caller),input=validateConfiguration(raw),db=await this.pool.connect();
    try {
      await db.query('BEGIN');await lockCapacity(db);
      if(input.action==='UPDATE_SETTINGS') {
        const result=await db.query(`UPDATE booking_settings SET block_minutes=$1,revision=revision+1,updated_at=now(),updated_by=$2
          WHERE id='default' AND revision=$3 RETURNING id,block_minutes,revision,updated_at,updated_by`,[input.blockMinutes,actor.uid,input.expectedRevision]);
        if(!result.rowCount) throw new HttpsError('aborted','BOOKING_CONFIGURATION_CONFLICT');
        await db.query('COMMIT');const s=result.rows[0];
        return {id:s.id,blockMinutes:s.block_minutes,revision:s.revision,updatedAt:s.updated_at.toISOString(),updatedBy:s.updated_by};
      }
      const result=input.action==='CREATE_GROUP'?
        await db.query(`INSERT INTO capacity_group(id,code,name,capacity_per_block,archived,revision,created_at,updated_at,updated_by)
          VALUES($1,$2,$3,$4,false,0,now(),now(),$5) RETURNING *`,[input.id,input.code,input.name,input.capacityPerBlock,actor.uid]):
        await db.query(`UPDATE capacity_group SET name=$2,capacity_per_block=$3,archived=$4,revision=revision+1,updated_at=now(),updated_by=$5
          WHERE id=$1 AND revision=$6 RETURNING *`,[input.id,input.name,input.capacityPerBlock,input.archived,actor.uid,input.expectedRevision]);
      if(!result.rowCount) throw new HttpsError('aborted','BOOKING_CONFIGURATION_CONFLICT');
      await db.query('COMMIT');const g=result.rows[0];
      return {id:g.id,code:g.code,name:g.name,capacityPerBlock:g.capacity_per_block,archived:g.archived,revision:g.revision,
        createdAt:g.created_at.toISOString(),updatedAt:g.updated_at.toISOString(),updatedBy:g.updated_by};
    } catch(error) {await db.query('ROLLBACK').catch(()=>{});configurationError(error);} finally {db.release();}
  }
}

export function validateAvailability(raw:unknown) {
  const v=raw as {day?:unknown; offset?:unknown};
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['day','offset'].includes(k))||
    typeof v.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.day)||v.day<'0001-01-01'||
    !Number.isFinite(Date.parse(v.day+'T00:00:00Z'))||new Date(v.day+'T00:00:00Z').toISOString().slice(0,10)!==v.day||!integer(v.offset??0))
    throw new HttpsError('invalid-argument','BOOKING_AVAILABILITY_INVALID');
  return {day:v.day,offset:Number(v.offset??0)};
}
export class BookingAvailabilityService {
  constructor(private readonly pool:Pool) {}
  async get(caller:OrderCaller|undefined,raw:unknown) {
    requireOrderCaller(caller);const input=validateAvailability(raw),db=await this.pool.connect();
    try {
      // Settings, revisions and counts must describe the same committed snapshot.
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const s=(await db.query("SELECT * FROM booking_settings WHERE id='default'")).rows[0];
      if(!s) throw new HttpsError('failed-precondition','BOOKING_NOT_CONFIGURED');
      const rows=(await db.query(`SELECT g.id,g.code,g.name,g.archived,g.revision,g.capacity_per_block,b.minute,
          COALESCE(a.booked,0)::text AS booked,(g.capacity_per_block-COALESCE(a.booked,0))::text AS remaining
        FROM capacity_group g CROSS JOIN unnest($2::integer[]) b(minute)
        LEFT JOIN (SELECT a.group_id,a.block_minute,sum(a.quantity)::bigint AS booked
          FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
          WHERE a.pickup_day=$1 AND o.status<>'CANCELLED' GROUP BY a.group_id,a.block_minute) a
          ON a.group_id=g.id AND a.block_minute=b.minute
        ORDER BY g.id,b.minute LIMIT 101 OFFSET $3`,[input.day,s.block_minutes,input.offset])).rows;
      await db.query('COMMIT');
      return {day:input.day,timeZone:'America/Toronto',settings:{blockMinutes:s.block_minutes,revision:s.revision},
        blocks:rows.slice(0,100).map(r=>({groupId:r.id,groupCode:r.code,groupName:r.name,archived:r.archived,groupRevision:r.revision,
          blockMinute:r.minute,capacity:r.capacity_per_block,booked:r.booked,remaining:r.remaining})),
        nextOffset:rows.length>100?input.offset+100:null};
    } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;} finally {db.release();}
  }
}
