import {HttpsError} from 'firebase-functions/v2/https';
import type {PoolClient} from 'pg';
import {integer, uuid} from './booking';

type SpecialDayValues = {capacityPerBlock:number; dayKeys:number[]};
export type SpecialDayChange =
  ({action:'CREATE_SPECIAL_DAY'; id:string; groupId:string} & SpecialDayValues) |
  ({action:'UPDATE_SPECIAL_DAY'; id:string; expectedRevision:number} & SpecialDayValues) |
  {action:'REMOVE_SPECIAL_DAY'; id:string; expectedRevision:number};

export function isSpecialDayAction(action:unknown) {
  return action==='CREATE_SPECIAL_DAY'||action==='UPDATE_SPECIAL_DAY'||action==='REMOVE_SPECIAL_DAY';
}

export function validateSpecialDay(v:Record<string,unknown>):SpecialDayChange {
  const fail=():never=>{throw new HttpsError('invalid-argument','BOOKING_CONFIGURATION_INVALID');};
  const action=v.action;
  if(!isSpecialDayAction(action)||typeof v.id!=='string'||!uuid.test(v.id)) return fail();
  const id=v.id.toLowerCase();
  const allowed=['action','id',action==='CREATE_SPECIAL_DAY'?'groupId':'expectedRevision'];
  if(action!=='REMOVE_SPECIAL_DAY') allowed.push('capacityPerBlock','dayKeys');
  if(Object.keys(v).some(key=>!allowed.includes(key))) return fail();
  if(action!=='CREATE_SPECIAL_DAY'&&!integer(v.expectedRevision,0,2147483646)) return fail();
  if(action==='REMOVE_SPECIAL_DAY') return {action,id,expectedRevision:Number(v.expectedRevision)};
  const monthLengths=[31,29,31,30,31,30,31,31,30,31,30,31];
  if(!integer(v.capacityPerBlock)||!Array.isArray(v.dayKeys)||!v.dayKeys.length||v.dayKeys.length>366||
     new Set(v.dayKeys).size!==v.dayKeys.length||v.dayKeys.some(key=>
       !integer(key,101,1231)||!integer(key%100,1,monthLengths[Math.floor(key/100)-1]))) return fail();
  const values={id,capacityPerBlock:v.capacityPerBlock,dayKeys:[...v.dayKeys].sort((a,b)=>a-b)};
  if(action==='CREATE_SPECIAL_DAY') {
    if(typeof v.groupId!=='string'||!uuid.test(v.groupId)) return fail();
    return {action,...values,groupId:v.groupId.toLowerCase()};
  }
  return {action:'UPDATE_SPECIAL_DAY',...values,expectedRevision:Number(v.expectedRevision)};
}

type RuleRow = {id:string;group_id:string;capacity_per_block:number;day_keys:number[];
  revision:number;saved_revision:number;updated_at:Date};

function savedRule(row:RuleRow) {
  return {id:row.id,groupId:row.group_id,capacityPerBlock:row.capacity_per_block,dayKeys:row.day_keys,
    revision:row.revision,savedRevision:row.saved_revision,updatedAt:row.updated_at.toISOString()};
}

/** Runs inside the booking configuration transaction with the shared lock held. */
export async function changeSpecialDay(db:PoolClient, actorUid:string, input:SpecialDayChange) {
  const prior=(await db.query<RuleRow>('SELECT * FROM special_day_rule WHERE id=$1',[input.id])).rows[0];
  const conflict=():never=>{throw new HttpsError('aborted','BOOKING_CONFIGURATION_CONFLICT');};
  if(input.action==='CREATE_SPECIAL_DAY'&&prior) {
    if(prior.group_id!==input.groupId||prior.capacity_per_block!==input.capacityPerBlock||
      prior.day_keys.length!==input.dayKeys.length||prior.day_keys.some((day,i)=>day!==input.dayKeys[i])) return conflict();
    return {rule:savedRule(prior)};
  }
  if(input.action!=='CREATE_SPECIAL_DAY'&&prior?.revision!==input.expectedRevision) return conflict();
  const groupId=input.action==='CREATE_SPECIAL_DAY'?input.groupId:prior.group_id;
  const group=await db.query('SELECT id FROM capacity_group WHERE id=$1 AND NOT archived',[groupId]);
  if(!group.rowCount) throw new HttpsError('failed-precondition','SPECIAL_DAY_GROUP_UNAVAILABLE');

  const settings=await db.query(`UPDATE booking_settings SET revision=revision+1,updated_at=clock_timestamp(),updated_by=$1
    WHERE id='default' RETURNING revision,updated_at`,[actorUid]);
  if(!settings.rowCount) throw new HttpsError('failed-precondition','BOOKING_NOT_CONFIGURED');
  const {revision,updated_at:updatedAt}=settings.rows[0];
  if(input.action==='REMOVE_SPECIAL_DAY') {
    await db.query('DELETE FROM special_day_rule WHERE id=$1',[input.id]);
    return {removedId:input.id};
  }
  const parameters=[input.id,groupId,input.capacityPerBlock,input.dayKeys,revision,updatedAt,actorUid];
  const result=input.action==='CREATE_SPECIAL_DAY'?
    await db.query<RuleRow>(`INSERT INTO special_day_rule(id,group_id,capacity_per_block,day_keys,revision,saved_revision,updated_at,updated_by)
      VALUES($1,$2,$3,$4,0,$5,$6,$7) RETURNING *`,parameters):
    await db.query<RuleRow>(`UPDATE special_day_rule SET capacity_per_block=$3,day_keys=$4,revision=revision+1,
      saved_revision=$5,updated_at=$6,updated_by=$7 WHERE id=$1 AND group_id=$2 RETURNING *`,parameters);
  return {rule:savedRule(result.rows[0])};
}
