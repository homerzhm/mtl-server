import {HttpsError} from 'firebase-functions/v2/https';

export const timeZone = 'America/Toronto';
export type CreateInput = {
  id: string; items: {id:string; productId:string; expectedRevision:number; quantity:number}[];
  clientId: string | null; contactPhoneNumber: string | null; scheduledFor: string;
  expectedSettingsRevision: number; expectedGroups: {id:string; expectedRevision:number}[];
  allocations: {groupId:string; blockMinute:number; quantity:number}[]; depositRequiredCents:number; notes:string | null;
};
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const integer = (v:unknown, min=0, max=2147483647): v is number => Number.isInteger(v) && Number(v)>=min && Number(v)<=max;
function invalid(): never { throw new HttpsError('invalid-argument','Check the order fields'); }
function keys(v:object, allowed:string[]) { if(Object.keys(v).some(k=>!allowed.includes(k))) invalid(); }
export function localParts(date:Date) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=(name:string)=>parts.find(p=>p.type===name)!.value;
  return {day:`${get('year')}-${get('month')}-${get('day')}`, minute:Number(get('hour'))*60+Number(get('minute')),second:Number(get('second'))};
}
export function validateInput(value:unknown): CreateInput {
  if(!value || typeof value!=='object'||Array.isArray(value)) invalid();
  const v=value as CreateInput;
  keys(v,['id','items','clientId','contactPhoneNumber','scheduledFor','allocations','expectedSettingsRevision','expectedGroups','depositRequiredCents','notes']);
  if(typeof v.id!=='string'||!uuid.test(v.id)||!Array.isArray(v.items)||!v.items.length||v.items.length>100||
    !Array.isArray(v.allocations)||v.allocations.length>9600||!integer(v.expectedSettingsRevision)||!Array.isArray(v.expectedGroups)||v.expectedGroups.length>100||!integer(v.depositRequiredCents)||
    (v.clientId!==null&&(typeof v.clientId!=='string'||!uuid.test(v.clientId)))||
    (v.notes!==null&&(typeof v.notes!=='string'||v.notes.length>10000))||
    typeof v.scheduledFor!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.scheduledFor)||!Number.isFinite(Date.parse(v.scheduledFor))) invalid();
  if(new Date(v.scheduledFor).toISOString().replace('.000Z','Z')!==v.scheduledFor.replace('.000Z','Z')) invalid();
  let phone=v.contactPhoneNumber;
  if(phone!==null) {
    if(typeof phone!=='string') invalid();
    if(/^[0-9]{10}$/.test(phone)) phone='+1'+phone;
    if(!/^\+[1-9][0-9]{1,14}$/.test(phone)) invalid();
  }
  const ids=new Set<string>(), products=new Set<string>();
  const items=v.items.map(item=>{
    if(!item||typeof item!=='object') invalid();
    keys(item,['id','productId','expectedRevision','quantity']);
    if(typeof item.id!=='string'||!uuid.test(item.id)||typeof item.productId!=='string'||!uuid.test(item.productId)||!integer(item.quantity,1,99)||!integer(item.expectedRevision)||ids.has(item.id.toLowerCase())||products.has(item.productId.toLowerCase())) invalid();
    ids.add(item.id.toLowerCase());products.add(item.productId.toLowerCase());
    return {id:item.id.toLowerCase(),productId:item.productId.toLowerCase(),expectedRevision:item.expectedRevision,quantity:item.quantity};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const groupIds=new Set<string>();
  const expectedGroups=v.expectedGroups.map(g=>{
    if(!g||typeof g!=='object'||Array.isArray(g)) invalid();
    keys(g,['id','expectedRevision']);
    if(typeof g.id!=='string'||!uuid.test(g.id)||!integer(g.expectedRevision)||groupIds.has(g.id.toLowerCase())) invalid();
    groupIds.add(g.id.toLowerCase());
    return {id:g.id.toLowerCase(),expectedRevision:g.expectedRevision};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const slots=new Set<string>();
  const allocations=v.allocations.map(a=>{
    if(!a||typeof a!=='object'||Array.isArray(a)) invalid();
    keys(a,['groupId','blockMinute','quantity']);
    if(typeof a.groupId!=='string'||!uuid.test(a.groupId)||!integer(a.blockMinute,0,1439)||a.blockMinute%15!==0||!integer(a.quantity,1)) invalid();
    const groupId=a.groupId.toLowerCase(), slot=groupId+':'+a.blockMinute;
    if(slots.has(slot)) invalid();
    slots.add(slot);return {groupId,blockMinute:a.blockMinute,quantity:a.quantity};
  }).sort((a,b)=>a.groupId.localeCompare(b.groupId)||a.blockMinute-b.blockMinute);
  return {id:v.id.toLowerCase(),items,clientId:v.clientId?.toLowerCase()??null,contactPhoneNumber:phone,
    scheduledFor:new Date(v.scheduledFor).toISOString(),allocations,expectedSettingsRevision:v.expectedSettingsRevision,expectedGroups,depositRequiredCents:v.depositRequiredCents,notes:v.notes};
}
export function validateTiming(input:CreateInput, now:Date) {
  const pickup=new Date(input.scheduledFor), p=localParts(pickup), n=localParts(now);
  if(pickup<=now||p.second!==0||pickup.getUTCMilliseconds()!==0||p.minute%15!==0||
    input.allocations.some(a=>a.blockMinute>p.minute||(p.day===n.day&&a.blockMinute<=n.minute))) {
    throw new HttpsError('failed-precondition','PICKUP_EXPIRED');
  }
  return p;
}
