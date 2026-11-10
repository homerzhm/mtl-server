import {parseArgs} from 'node:util';
import {getPool,closeDatabase} from './database';
async function main() {
  const {values}=parseArgs({options:{project:{type:'string'}}});
  if(!values.project)throw new Error('Pass --project explicitly');
  process.env.GCLOUD_PROJECT=values.project;
  const db=await (await getPool()).connect();
  try {
    await db.query('BEGIN');
    await db.query('LOCK TABLE customer_order,order_item IN SHARE ROW EXCLUSIVE MODE');
    const result=await db.query(`SELECT o.id FROM customer_order o JOIN order_item i ON i.order_id=o.id JOIN product p ON p.id=i.product_id
      WHERE o.status IN ('CONFIRMED','PAID') AND NOT o.booking_managed AND COALESCE(i.is_lechon_snapshot,p.is_lechon) LIMIT 1`);
    if(result.rowCount)throw new Error('Existing active lechon orders require a separate allocation backfill decision');
    await db.query('INSERT INTO order_booking_rollout(id,enabled) VALUES(true,true) ON CONFLICT(id) DO UPDATE SET enabled=true');
    await db.query('COMMIT');console.log('Roast booking enabled after fresh-environment check');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(closeDatabase);
