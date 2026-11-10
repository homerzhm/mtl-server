import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {defineString} from 'firebase-functions/params';
import {logger} from 'firebase-functions';
import {getPool} from './database';
import {OrderCreationService,requireOrderCaller} from './service';
const runtimeServiceAccount=defineString('ORDERS_RUNTIME_SERVICE_ACCOUNT');
export const createStaffOrder=onCall({region:'northamerica-northeast1',timeoutSeconds:60,maxInstances:1,concurrency:2,serviceAccount:runtimeServiceAccount},async request=>{
  const caller=requireOrderCaller(request.auth);
  try {return await new OrderCreationService(await getPool()).create(caller,request.data);}
  catch(error){if(error instanceof HttpsError)throw error;logger.error('Order creation failed',error);throw new HttpsError('internal','Order result uncertain; retry the same request');}
});
