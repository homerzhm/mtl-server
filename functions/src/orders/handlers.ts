import {BookingConfigurationService,BookingAvailabilityService,requireBookingAdmin} from './capacity';
import {OrderActionService} from './actions';
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

export const updateStaffOrder=onCall({region:'northamerica-northeast1',timeoutSeconds:60,maxInstances:1,concurrency:2,serviceAccount:runtimeServiceAccount},async request=>{
  const caller=requireOrderCaller(request.auth);
  try {return await new OrderActionService(await getPool()).perform(caller,request.data);}
  catch(error){if(error instanceof HttpsError)throw error;logger.error('Order action failed',error);throw new HttpsError('internal','Order result uncertain; retry the same request');}
});

export const manageBookingConfiguration=onCall({region:'northamerica-northeast1',timeoutSeconds:60,maxInstances:1,concurrency:2,serviceAccount:runtimeServiceAccount},async request=>{
  const caller=requireBookingAdmin(request.auth);
  try {return await new BookingConfigurationService(await getPool()).change(caller,request.data);}
  catch(error){if(error instanceof HttpsError)throw error;logger.error('Booking configuration failed',error);throw new HttpsError('internal','Could not save booking configuration; reload before retrying');}
});
export const getBookingAvailability=onCall({region:'northamerica-northeast1',timeoutSeconds:60,maxInstances:1,concurrency:2,serviceAccount:runtimeServiceAccount},async request=>{
  const caller=requireOrderCaller(request.auth);
  try {return await new BookingAvailabilityService(await getPool()).get(caller,request.data);}
  catch(error){if(error instanceof HttpsError)throw error;logger.error('Booking availability failed',error);throw new HttpsError('internal','Could not load booking availability');}
});
