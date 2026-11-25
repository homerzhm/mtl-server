import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,grantFixtures,parameters} from './fixture.mjs';
import {root,loadManifest,digest} from '../../scripts/release/config.mjs';
import {Client,withLock,verifyContract,assertPrivateLedger,assertEmpty,migrationState,applyMigrations,migrationChecksum,startRelease,releaseRow,markState,assertPromotable} from '../../scripts/release/database.mjs';
import {verifyPermissions} from '../../scripts/release/permissions.mjs';
import {componentStage} from '../../scripts/release/cli.mjs';
import {up as deploySpecialDaySchema} from '../../migrations/deploy-special-day-schema.mjs';
import {up as deployReportSchema} from '../../migrations/deploy-report-schema.mjs';
import {up as deployAutomaticRoastSchema} from '../../migrations/deploy-automatic-roast-schema.mjs';
import {up as deploySlipSchema} from '../../migrations/deploy-order-slip-schema.mjs';
let client,manifest;
before(async()=>{
  client=await fixture();manifest=await loadManifest();
  await grantFixtures(client);
  await client.query(await readFile(join(root,'release/operations.sql'),'utf8'));
});
after(async()=>{if(client)await client.end();});
async function rollback(work) {
  await client.query('BEGIN');try {await work();}finally{await client.query('ROLLBACK');}
}
test('fresh migration setup has no business seeds and only required schedule',async()=>{
  await assertEmpty(client);
  assert.deepEqual((await client.query('SELECT id,block_minutes FROM booking_settings')).rows,[{id:'default',block_minutes:[660,780,930,1080]}]);
  for(const t of ['staff_account','staff_role_change','staff_role_control']) assert.equal((await client.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n,0);
  assert.equal((await client.query(await readFile(join(root,'migrations/verify-mark-paid-with-balance.sql'),'utf8'))).rows[0].ok,true);
  assert.equal((await client.query(await readFile(join(root,'migrations/verify-historical-order-import.sql'),'utf8'))).rows[0].ok,true);
  await verifyContract(client,manifest);await verifyPermissions(client,parameters);await assertPrivateLedger(client,parameters);
});
test('slip maintenance prepares a private table and restores grants on interrupted registration',async()=>{
  await client.query('DROP TABLE public.order_slip_task');
  let registrations=0;
  const firebase=async(command,args)=>{
    assert.equal(command,'deploy');
    assert.deepEqual(args,['--only','dataconnect:restaurant:schema','--non-interactive']);
    registrations++;
    assert.equal((await client.query(await readFile(join(root,'migrations/verify-order-slip-schema.sql'),'utf8'))).rows[0].ok,true);
    assert.deepEqual((await client.query(`SELECT
      has_table_privilege('firebasereader_restaurant_public','public.order_slip_task','REFERENCES') AS ddl,
      has_table_privilege('firebasereader_restaurant_public','public.order_slip_task','SELECT') AS reads`)).rows,
    [{ddl:true,reads:false}]);
    await assert.rejects(client.query('DELETE FROM public.report_entry WHERE false'),{code:'55000'});
    await assert.rejects(client.query('DELETE FROM public.order_slip_task WHERE false'),{code:'55000'});
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='report_entry_values_check'")).rows[0].n,0);
    if(registrations===1) throw new Error('Slip registration interrupted');
  };
  await assert.rejects(deploySlipSchema(client,{parameters,firebase}),/Slip registration interrupted/);
  await verifyPermissions(client,parameters);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='report_entry_values_check'")).rows[0].n,1);
  await deploySlipSchema(client,{parameters,firebase});
  await client.query(await readFile(join(root,'migrations/order-slip-tasks.sql'),'utf8'));
  await client.query(await readFile(join(root,'migrations/order-slip-deepseek-provider.sql'),'utf8'));
  assert.equal((await client.query(await readFile(join(root,'migrations/verify-order-slip-deepseek-provider.sql'),'utf8'))).rows[0].ok,true);
  await verifyContract(client,manifest);
  await verifyPermissions(client,parameters);
  await rollback(async()=>{
    await client.query('GRANT SELECT(price_cents) ON public.product TO release_slips');
    await assert.rejects(verifyPermissions(client,parameters),/SLIPS unexpected SELECT/);
  });
  await rollback(async()=>{
    await client.query('GRANT SELECT(preview) ON public.order_slip_task TO firebasewriter_release');
    await assert.rejects(verifyPermissions(client,parameters),/Private order slip/);
  });
  await rollback(async()=>{
    await client.query('SET LOCAL ROLE release_slips');
    await client.query('SELECT id,name,chinese_name FROM public.product WHERE is_active');
    await assert.rejects(client.query('SELECT phone_number FROM public.client'),{code:'42501'});
  });
});

test('special-day schema maintenance creates SQL before registration and resumes an interrupted release',async()=>{
  const firebase=async (command,args)=>{
    assert.equal(command,'deploy');
    assert.deepEqual(args,['--only','dataconnect:restaurant:schema','--non-interactive']);
    const result=await client.query('SELECT count(*)::int n FROM public.special_day_rule');
    assert.equal(result.rows[0].n,0);
    const {rows:[access]}=await client.query(`SELECT
      has_table_privilege('firebasereader_restaurant_public','native_order_edit_context','SELECT') AS can_read,
      has_table_privilege('firebasereader_restaurant_public','native_order_edit_context','INSERT,UPDATE,DELETE') AS can_write`);
    assert.deepEqual(access,{can_read:true,can_write:false});
    await assert.rejects(client.query('UPDATE client SET name=name WHERE false'),{code:'55000'});
    const fk=(await client.query("SELECT confdeltype FROM pg_constraint WHERE conname='order_item_order_id_fkey'")).rows[0];
    assert.equal(fk.confdeltype,'c');
  };
  await client.query('DROP TABLE public.special_day_rule');
  await assert.rejects(deploySpecialDaySchema(client,{parameters,firebase:async (...args)=>{
    await firebase(...args);
    throw new Error('interrupted');
  }}),/interrupted/);
  const {rows:[restored]}=await client.query(`SELECT
    to_regclass('mtl_operations.special_day_constraint_snapshot') IS NULL AS snapshot_cleared,
    to_regprocedure('public.mtl_special_day_schema_pause()') IS NULL AS pause_cleared,
    (SELECT confdeltype FROM pg_constraint WHERE conname='order_item_order_id_fkey') AS delete_policy`);
  assert.deepEqual(restored,{snapshot_cleared:true,pause_cleared:true,delete_policy:'r'});
  await client.query('UPDATE client SET name=name WHERE false');
  await deploySpecialDaySchema(client,{firebase,parameters});
  await deploySpecialDaySchema(client,{firebase,parameters});
  await client.query(await readFile(join(root,'migrations/special-day-capacity.sql'),'utf8'));
  await verifyContract(client,manifest);
  await verifyPermissions(client,parameters);
  assert.equal((await client.query(await readFile(join(root,'migrations/verify-special-day-capacity.sql'),'utf8'))).rows[0].ok,true);
});
test('Report maintenance prepares both tables, restores native protections and keeps audit access private',async()=>{
  await client.query('DROP TABLE public.report_entry_change, public.report_entry');
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO firebasereader_release;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO firebasewriter_release`);
  const assertReportPrivate=async()=>{
    const {rows:[{exposed}]}=await client.query(`SELECT EXISTS (
      SELECT 1 FROM unnest(ARRAY['firebasereader_release','firebasewriter_release']) AS roles(name)
      CROSS JOIN unnest(ARRAY['public.report_entry','public.report_entry_change']) AS tables(name)
      WHERE has_table_privilege(roles.name,tables.name,'SELECT,INSERT,UPDATE,DELETE')
    ) AS exposed`);
    assert.equal(exposed,false);
  };
  let registrations=0;
  const firebase=async (command,args)=>{
    assert.equal(command,'deploy');
    assert.deepEqual(args,['--only','dataconnect:restaurant:schema','--non-interactive']);
    registrations++;
    const prerequisite=await client.query(await readFile(join(root,'migrations/verify-report-schema.sql'),'utf8'));
    assert.equal(prerequisite.rows[0].ok,true);
    await assertReportPrivate();
    const {rows:[{checkRemoved, schemaAccess}]}=await client.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='special_day_rule_values_valid') AS "checkRemoved",
      has_table_privilege('firebasereader_restaurant_public','public.report_entry','REFERENCES') AS "schemaAccess"`);
    assert.equal(checkRemoved,true);
    assert.equal(schemaAccess,true);
    await assert.rejects(client.query('DELETE FROM public.special_day_rule WHERE false'),{code:'55000'});
    await client.query('GRANT SELECT ON public.report_entry_change TO firebasereader_release');
  };
  try {
    await assert.rejects(deployReportSchema(client,{parameters,firebase:async (...args)=>{
      await firebase(...args);
      throw new Error('Report registration interrupted');
    }}),/Report registration interrupted/);
    await assertReportPrivate();
    await verifyPermissions(client,parameters);
    await client.query('DELETE FROM public.special_day_rule WHERE false');
    const {rows:[{ok}]}=await client.query(await readFile(join(root,'migrations/verify-special-day-capacity.sql'),'utf8'));
    assert.equal(ok,true);
  } finally {
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM firebasereader_release;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM firebasewriter_release`);
  }
  await deployReportSchema(client,{firebase,parameters});
  await deployReportSchema(client,{firebase,parameters});
  assert.equal(registrations,3);
  await client.query(await readFile(join(root,'migrations/report-constraints.sql'),'utf8'));
  await verifyContract(client,manifest);
  await verifyPermissions(client,parameters);
  await rollback(async()=>{
    await client.query('GRANT UPDATE(snapshot) ON public.report_entry_change TO release_report');
    await assert.rejects(verifyPermissions(client,parameters),/UPDATE privilege/);
  });
});
test('automatic roast schema stages columns and restores Report checks after interrupted registration',async()=>{
  await client.query(`DROP TRIGGER order_capacity_assignment_change ON public.customer_order;
    ALTER TABLE public.customer_order DROP CONSTRAINT customer_order_assignment_check,
      DROP COLUMN roast_block_needed_reason, DROP COLUMN price_override_cents`);
  const verifyColumns=await readFile(join(root,'migrations/verify-automatic-roast-schema.sql'),'utf8');
  const reportChecks=await readFile(join(root,'migrations/verify-report-constraints.sql'),'utf8');
  let registrations=0;
  const firebase=async(command,args)=>{
    registrations++;
    assert.equal(command,'deploy');
    assert.deepEqual(args,['--only','dataconnect:restaurant:schema','--non-interactive']);
    assert.equal((await client.query(verifyColumns)).rows[0].ok,true);
    assert.equal((await client.query(`SELECT has_column_privilege(
      'release_orders','public.customer_order','roast_block_needed_reason','UPDATE') ok`)).rows[0].ok,true);
    for(const table of ['customer_order','special_day_rule','report_entry','report_entry_change','order_slip_task']) {
      await assert.rejects(client.query(`DELETE FROM public.${table} WHERE false`),{code:'55000'});
    }
    if(registrations===1) throw new Error('Automatic roast registration interrupted');
  };
  await assert.rejects(deployAutomaticRoastSchema(client,{parameters,firebase}),/Automatic roast registration interrupted/);
  assert.equal((await client.query(reportChecks)).rows[0].ok,true);
  await deployAutomaticRoastSchema(client,{parameters,firebase});
  assert.equal(registrations,2);
  assert.equal((await client.query(reportChecks)).rows[0].ok,true);
  await client.query(await readFile(join(root,'migrations/automatic-roast-booking.sql'),'utf8'));
  const verifyBooking=await readFile(join(root,'migrations/verify-automatic-roast-booking.sql'),'utf8');
  assert.equal((await client.query(verifyBooking)).rows[0].ok,true);
  await verifyContract(client,manifest);
  await verifyPermissions(client,parameters);
});
test('native protection tampering and inherited private grants are detected',async()=>{
  await rollback(async()=>{
    await client.query('ALTER TABLE order_audit_event DISABLE TRIGGER order_audit_immutable');
    await assert.rejects(verifyContract(client,manifest),/contract mismatch/);
  });
  await rollback(async()=>{
    await client.query('GRANT SELECT ON mtl_operations.release TO release_staff');
    await assert.rejects(assertPrivateLedger(client,parameters),/metadata exposed/);
  });
  await rollback(async()=>{
    await client.query('GRANT SELECT(commit_sha) ON mtl_operations.release TO release_staff');
    await assert.rejects(assertPrivateLedger(client,parameters),/metadata exposed/);
  });
  await rollback(async()=>{
    await client.query('GRANT UPDATE(price_cents) ON product TO release_orders');
    await assert.rejects(verifyPermissions(client,parameters),/UPDATE privilege/);
  });
  await rollback(async()=>{
    await client.query('GRANT EXECUTE ON FUNCTION apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb) TO firebasereader_release');
    await assert.rejects(verifyPermissions(client,parameters),/Private order edit/);
  });
});
test('cloud UUID defaults require the genuine uuid-ossp generator',async()=>{
  await rollback(async()=>{
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('ALTER TABLE product ALTER COLUMN id SET DEFAULT uuid_generate_v4()');
    await verifyContract(client,manifest);
    await client.query("CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000000'::uuid $$");
    await assert.rejects(verifyContract(client,manifest),/genuine uuid-ossp/);
  });
});
test('capacity reference repair restores SET NULL to RESTRICT without altering rows or audit triggers',async()=>{
  const before=(await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='order_audit_event'::regclass ORDER BY tgname")).rows;
  await client.query('ALTER TABLE order_item DROP CONSTRAINT order_item_capacity_group_id_fkey; ALTER TABLE order_item ADD CONSTRAINT order_item_capacity_group_id_fkey FOREIGN KEY(capacity_group_id) REFERENCES capacity_group(id) ON DELETE SET NULL');
  const sql=await readFile(join(root,'migrations/restore-item-capacity-reference.sql'),'utf8');
  await client.query(sql);await client.query(sql);
  assert.equal((await client.query(await readFile(join(root,'migrations/verify-item-capacity-reference.sql'),'utf8'))).rows[0].ok,true);
  assert.deepEqual((await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='order_audit_event'::regclass ORDER BY tgname")).rows,before);
  await verifyContract(client,manifest);
});
test('session advisory lock excludes concurrent deployment, releases on failure',async()=>{
  const other=new Client({connectionString:process.env.MTL_RELEASE_TEST_DATABASE_URL});await other.connect();
  try {
    await assert.rejects(withLock(client,async()=>{
      await assert.rejects(withLock(other,async()=>assert.fail('entered concurrent release')),/Another release/);
      throw new Error('interrupted');
    }),/interrupted/);
    await withLock(other,async()=>{});
  } finally {await other.end();}
});
async function migrateItem(id,file,verify,mode='transaction') {
  return {id,file,mode,verify,checksum:digest(await readFile(join(root,file))),verifyChecksum:digest(await readFile(join(root,verify))),...(mode==='maintenance'?{procedureChecksum:'reviewed-fixture'}:{})};
}
test('migration history enforces ordered prefix, exact checksums and no omitted history',async()=>{
  for(const m of manifest.migrations) await client.query('INSERT INTO mtl_operations.migration(id,checksum,commit_sha) VALUES($1,$2,$3)',[m.id,migrationChecksum(m),'baseline']);
  assert.deepEqual(await migrationState(client,manifest),[]);
  const changed=structuredClone(manifest);changed.migrations[0].checksum='changed';
  await assert.rejects(migrationState(client,changed),/checksum drift/);
  await assert.rejects(migrationState(client,{...manifest,migrations:manifest.migrations.slice(1)}),/omitted history/);
  await rollback(async()=>{
    await client.query('DELETE FROM mtl_operations.migration WHERE id=$1',[manifest.migrations[0].id]);
    await assert.rejects(migrationState(client,manifest),/out of order/);
  });
});
test('transaction migrations record atomically; failure resumes without reapplying successful DDL',async()=>{
  const first=await migrateItem('900-probe','test/release/fixtures/007-add-probe.sql','test/release/fixtures/verify-probe.sql');
  const fail=await migrateItem('901-fail','test/release/fixtures/008-fail.sql','test/release/fixtures/verify-probe.sql');
  const m={...manifest,migrations:[...manifest.migrations,first,fail]};
  await assert.rejects(applyMigrations(client,m,'commit'),/division by zero/);
  assert.equal((await client.query('SELECT count(*)::int n FROM mtl_operations.probe')).rows[0].n,1);
  assert.equal((await client.query('SELECT count(*)::int n FROM mtl_operations.migration WHERE id=$1',[fail.id])).rows[0].n,0);
  await applyMigrations(client,{...m,migrations:m.migrations.slice(0,-1)},'commit');
  assert.equal((await client.query('SELECT count(*)::int n FROM mtl_operations.probe')).rows[0].n,1);
});
test('nontransactional maintenance resumes after verification failure without duplicating effects',async()=>{
  const probe=await migrateItem('900-probe','test/release/fixtures/007-add-probe.sql','test/release/fixtures/verify-probe.sql');
  const item=await migrateItem('901-maintenance','test/release/fixtures/maintenance.mjs','test/release/fixtures/verify-maintenance.sql','maintenance');
  const broken={...item,verify:'test/release/fixtures/008-fail.sql'};
  await assert.rejects(applyMigrations(client,{...manifest,migrations:[...manifest.migrations,probe,broken]},'commit'));
  assert.equal((await client.query('SELECT count(*)::int n FROM mtl_operations.maintenance_probe')).rows[0].n,1);
  await applyMigrations(client,{...manifest,migrations:[...manifest.migrations,probe,item]},'commit');
  await applyMigrations(client,{...manifest,migrations:[...manifest.migrations,probe,item]},'commit');
  assert.equal((await client.query('SELECT count(*)::int n FROM mtl_operations.maintenance_probe')).rows[0].n,1);
  // Test history is isolated from subsequent promotion assertions.
  await client.query("DELETE FROM mtl_operations.migration WHERE id IN ('900-probe','901-maintenance')");
});
test('component retries skip verified completed stages, retain failure and reject drift',async()=>{
  const commit='abc123';await startRelease(client,commit,manifest);
  let deployments=0;
  const args={client,commit,manifest,name:'connector',deploy:async()=>{deployments++;},verify:async()=> 'source-checksum'};
  await componentStage(args);
  await markState(client,commit,manifest,'failed');
  await startRelease(client,commit,manifest);await componentStage(args);
  assert.equal(deployments,1);assert.equal((await releaseRow(client,commit,manifest)).state,'deploying');
  await assert.rejects(componentStage({...args,verify:async()=> 'drift'}),/drifted/);
  await assert.rejects(componentStage({...args,name:'functions',deploy:async()=>{throw new Error('cloud failed');}}),/cloud failed/);
  assert.equal((await releaseRow(client,commit,manifest)).stages.functions,undefined);
});
test('promotion requires current verified exact commit, checksums and resource fingerprint',async()=>{
  await markState(client,'abc123',manifest,'deployed','resources');
  await assert.rejects(assertPromotable(client,'abc123',manifest,'resources'),/verified dev/);
  await client.query("UPDATE mtl_operations.release SET state='verified',verified_at=now(),accepted_by=current_user WHERE commit_sha='abc123'");
  await assertPromotable(client,'abc123',manifest,'resources');
  await assert.rejects(assertPromotable(client,'other',manifest,'resources'),/verified dev/);
  await assert.rejects(assertPromotable(client,'abc123',manifest,'changed'),/verified dev/);
  await assert.rejects(assertPromotable(client,'abc123',{...manifest,checksum:'changed'},'resources'),/verified dev/);
  await startRelease(client,'newer',manifest);
  await assert.rejects(assertPromotable(client,'abc123',manifest,'resources'),/current verified/);
});
