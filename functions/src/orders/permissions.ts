import {HttpsError} from 'firebase-functions/v2/https';

export type OrderCaller={uid:string;token:Record<string,unknown>};
export function requireOrderCaller(caller:OrderCaller|undefined):OrderCaller {
  if(!caller) throw new HttpsError('unauthenticated','Sign in');
  const firebase=caller.token.firebase as {sign_in_provider?:string}|undefined;
  if(!caller.uid||firebase?.sign_in_provider!=='google.com'||(caller.token.staff!==true&&caller.token.admin!==true))
    throw new HttpsError('permission-denied','Staff access required');
  return caller;
}
