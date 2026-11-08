import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Optional native-PostgreSQL verification, using pg from a local Firebase CLI
// installation. The database and HTTP endpoints are deliberately fixed local.
// Run this file alone, or use --test-concurrency=1 with other files: the local
// PGlite TCP adapter cannot safely mix direct SQL sessions and connector tests
// in separate workers. This is a test-emulator restriction.
const modulePath=process.env.MTL_TEST_PG_MODULE;
if (!modulePath) {
  test('SQL integrity checks require MTL_TEST_PG_MODULE pointing to pg', {skip:true},()=>{});
} else {
  const {Client}=createRequire(import.meta.url)(modulePath);
  const db=new Client({host:'127.0.0.1',port:5432,database:'restaurant',user:'postgres',password:'',ssl:false});
  before(async()=>{
    // A request initializes the emulator schema before direct SQL verification.
    const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
    const token=`${encode({alg:'none',typ:'JWT'})}.${encode({aud:'demo-mtl',iss:'https://securetoken.google.com/demo-mtl',sub:'sql-test',staff:true,firebase:{sign_in_provider:'google.com'},iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}.`;
    const response=await fetch('http://127.0.0.1:9399/v1/projects/demo-mtl/locations/northamerica-northeast1/services/restaurant/connectors/staff-admin:executeQuery',{
      method:'POST',headers:{'Content-Type':'application/json','x-firebase-auth-token':token},body:JSON.stringify({operationName:'ListOrders',variables:{}})
    });
    const result=await response.json();
    assert.equal(response.ok && !result.errors?.length,true,JSON.stringify(result));
    await db.connect();
    const sql=await readFile(new URL('../migrations/order-integrity.sql',import.meta.url),'utf8');
    await db.query(sql);
    await db.query(sql); // Migration must be safely repeatable.
    const upgrade=await readFile(new URL('../migrations/order-paid-status.sql',import.meta.url),'utf8');
    await db.query(upgrade);
    await db.query(upgrade);
  });
  after(async()=>{await db.end();});

  async function fixture() {
    const id=randomUUID();
    await db.query('INSERT INTO customer_order (id, order_number, subtotal_cents, item_count, created_at, updated_at) VALUES ($1,$2,100,1,now(),now())',[id,'K'+randomUUID().replaceAll('-','').slice(0,5).toUpperCase().replaceAll('0','G').replaceAll('1','H')]);
    return id;
  }
  async function transaction(work) {
    await db.query('BEGIN');
    try {await work();} finally {await db.query('ROLLBACK');}
  }
  async function fails(sql,params,code) {
    await db.query('SAVEPOINT invalid_write');
    await assert.rejects(db.query(sql,params),error=>error.code===code);
    await db.query('ROLLBACK TO SAVEPOINT invalid_write');
  }

  test('paid status upgrade broadens the old CHECK without changing existing orders',async()=>{
    await transaction(async()=>{
      const id=await fixture();
      const {rows:before}=await db.query('SELECT * FROM customer_order WHERE id=$1',[id]);
      const initial=await readFile(new URL('../migrations/order-integrity.sql',import.meta.url),'utf8');
      const predicate=initial.match(/\('customer_order', 'customer_order_values_check',\s*\$\$([\s\S]*?)\$\$\)/)[1];
      const old=predicate.replaceAll(",'PAID'",'');
      await db.query(`ALTER TABLE customer_order DROP CONSTRAINT customer_order_values_check, ADD CONSTRAINT customer_order_values_check CHECK (${old})`);
      await fails("UPDATE customer_order SET status='PAID' WHERE id=$1",[id],'23514');
      const migration=await readFile(new URL('../migrations/order-paid-status.sql',import.meta.url),'utf8');
      // Keep the test's outer transaction so all fixtures and DDL roll back.
      await db.query(migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
      const {rows:after}=await db.query('SELECT * FROM customer_order WHERE id=$1',[id]);
      assert.deepEqual(after,before);
      await db.query("UPDATE customer_order SET status='PAID' WHERE id=$1",[id]);
      await fails('UPDATE customer_order SET completed_at=now() WHERE id=$1',[id],'23514');
      const protections=await db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND confdeltype='r' AND conrelid IN ('customer_order'::regclass,'order_item'::regclass,'payment'::regclass,'refund'::regclass,'order_audit_event'::regclass)");
      assert.equal(protections.rows[0].n,6);
    });
  });

  test('PostgreSQL enforces order values, identity, phone format and unique order numbers',async()=>{
    await transaction(async()=>{
      const id=await fixture();
      for(const clause of ["subtotal_cents = -1","item_count = 0","discount_cents = 101","contact_phone_number = '9055550123'","status = 'COMPLETED'","status = 'INVALID'","final_total_cents = -1"])
        await fails(`UPDATE customer_order SET ${clause} WHERE id = $1`,[id],'23514');
      await fails("UPDATE customer_order SET order_number = 'K7M4R9' WHERE id = $1",[id],'23514');
      await fails('INSERT INTO customer_order (id, order_number, subtotal_cents, item_count, created_at, updated_at) SELECT $1, order_number, 100, 1, now(), now() FROM customer_order WHERE id=$2',[randomUUID(),id],'23505');
    });
  });

  test('PostgreSQL audit rows cannot be updated, deleted or truncated; revisions are unique',async()=>{
    await transaction(async()=>{
      const id=await fixture();
      await db.query("INSERT INTO order_audit_event (id, order_id, action, actor_uid, occurred_at, order_revision, changes) VALUES ($1,$2,'ORDER_CREATED','sql-test',now(),0,'{\"before\":null,\"after\":{}}')",[randomUUID(),id]);
      await fails("UPDATE order_audit_event SET actor_uid='changed' WHERE order_id=$1",[id],'23514');
      await fails('DELETE FROM order_audit_event WHERE order_id=$1',[id],'23514');
      await fails('TRUNCATE order_audit_event',[],'23514');
      await fails("INSERT INTO order_audit_event (id, order_id, action, actor_uid, occurred_at, order_revision, changes) VALUES ($1,$2,'OTHER','sql-test',now(),0,'{\"before\":null,\"after\":{}}')",[randomUUID(),id],'23505');
      await fails('DELETE FROM customer_order WHERE id=$1',[id],'23503');
    });
  });

  test('PostgreSQL rejects invalid ledger amounts and preserves related orders',async()=>{
    await transaction(async()=>{
      const id=await fixture();
      await fails('INSERT INTO payment (id,order_id,amount_cents,received_at,created_at) VALUES ($1,$2,0,now(),now())',[randomUUID(),id],'23514');
      await db.query('INSERT INTO payment (id,order_id,amount_cents,received_at,created_at) VALUES ($1,$2,100,now(),now())',[randomUUID(),id]);
      await fails('DELETE FROM customer_order WHERE id=$1',[id],'23503');
      await fails('INSERT INTO refund (id,payment_id,amount_cents,created_at) VALUES ($1,$2,10,now())',[randomUUID(),randomUUID()],'23503');
    });
  });

  // Rerun the behavior suite with database checks/triggers enabled, rather than
  // only validating hand-written SQL fixtures.
  await import('./orders.test.mjs');
}
