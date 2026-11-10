import {HttpsError} from 'firebase-functions/v2/https';

export const blockMinutes = [660, 780, 930, 1080];
export const capacity = 18;
export const timeZone = 'America/Toronto';
export type CreateInput = {
  id: string; items: {id:string; productId:string; expectedRevision:number; quantity:number}[];
  clientId: string | null; contactPhoneNumber: string | null; scheduledFor: string;
  allocations: {minute:number; pigs:number}[]; depositRequiredCents:number; notes:string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (v:unknown, min=0, max=2147483647): v is number => Number.isInteger(v) && Number(v)>=min && Number(v)<=max;
function invalid(): never { throw new HttpsError('invalid-argument','Check the order fields'); }
function keys(v:object, allowed:string[]) { if(Object.keys(v).some(k=>!allowed.includes(k))) invalid(); }
export function localParts(date:Date) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=(name:string)=>parts.find(p=>p.type===name)!.value;
  return {day:`${get('year')}-${get('month')}-${get('day')}`, minute:Number(get('hour'))*60+Number(get('minute')),second:Number(get('second'))};
}
export function validateInput(value:unknown): CreateInput {
  if(!value || typeof value!=='object') invalid();
  const v=value as CreateInput;
  keys(v,['id','items','clientId','contactPhoneNumber','scheduledFor','allocations','depositRequiredCents','notes']);
  if(typeof v.id!=='string'||!uuid.test(v.id)||!Array.isArray(v.items)||!v.items.length||v.items.length>100||
    !Array.isArray(v.allocations)||v.allocations.length>4||!integer(v.depositRequiredCents)||
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
    if(!uuid.test(item.id)||!uuid.test(item.productId)||!integer(item.quantity,1,99)||!integer(item.expectedRevision)||ids.has(item.id.toLowerCase())||products.has(item.productId.toLowerCase())) invalid();
    ids.add(item.id.toLowerCase());products.add(item.productId.toLowerCase());
    return {id:item.id.toLowerCase(),productId:item.productId.toLowerCase(),expectedRevision:item.expectedRevision,quantity:item.quantity};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const minutes=new Set<number>();
  const allocations=v.allocations.map(a=>{
    if(!a||typeof a!=='object') invalid();
    keys(a,['minute','pigs']);
    if(!blockMinutes.includes(a.minute)||!integer(a.pigs,1,capacity)||minutes.has(a.minute)) invalid();
    minutes.add(a.minute);return {minute:a.minute,pigs:a.pigs};
  }).sort((a,b)=>a.minute-b.minute);
  return {id:v.id.toLowerCase(),items,clientId:v.clientId?.toLowerCase()??null,contactPhoneNumber:phone,
    scheduledFor:new Date(v.scheduledFor).toISOString(),allocations,depositRequiredCents:v.depositRequiredCents,notes:v.notes};
}
export function validateTiming(input:CreateInput, now:Date) {
  const pickup=new Date(input.scheduledFor), p=localParts(pickup), n=localParts(now);
  if(pickup<=now||p.second!==0||pickup.getUTCMilliseconds()!==0||p.minute%15!==0||
    input.allocations.some(a=>a.minute>p.minute||(p.day===n.day&&a.minute<=n.minute))) {
    throw new HttpsError('failed-precondition','PICKUP_EXPIRED');
  }
  return p;
}
