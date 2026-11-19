// Effective privileges, including inherited grants. Keep this contract aligned
// with the documented topic grants; table ownership is never a runtime grant.
export const policies = {
  STAFF: {
    select:['staff_account','staff_role_change','staff_role_control'],
    insert:['staff_account','staff_role_change','staff_role_control'],
    update:{staff_account:'*',staff_role_change:'*',staff_role_control:'*'},
    execute:[],
  },
  ORDERS: {
    select:['product','client','customer_order','order_item','order_capacity_allocation','order_creation_request','order_action_request','payment','refund','booking_settings','capacity_group','special_day_rule'],
    insert:['customer_order','order_item','order_capacity_allocation','order_creation_request','order_action_request','payment','refund','order_audit_event','capacity_group','special_day_rule'],
    delete:['special_day_rule'],
    update:{special_day_rule:['capacity_per_block','day_keys','revision','saved_revision','updated_at','updated_by'],customer_order:['revision','status','final_total_cents','completed_at','updated_at','cancelled_at','cancellation_total_cents'],payment:['amount_cents','status'],booking_settings:['block_minutes','revision','updated_at','updated_by'],capacity_group:['name','capacity_per_block','archived','revision','updated_at','updated_by']},
    execute:['lock_order_creation_sources(uuid[],uuid)','apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)'],
  },
  REPORT: {
    select:['report_entry','report_entry_change'],
    insert:['report_entry','report_entry_change'],
    update:{report_entry:['amount_cents','notes','revision','deleted_at']},
    execute:[],
  },
};
export async function verifyPermissions(client,parameters) {
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(x=>x.tablename);
  for(const [topic,policy] of Object.entries(policies)) {
    const user=parameters[`${topic}_SQL_USER`];
    const role=(await client.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[user])).rows[0];
    if(!role || Object.values(role).some(Boolean)) throw new Error(`${topic} runtime missing or privileged`);
    const access=(await client.query("SELECT has_database_privilege($1,current_database(),'CONNECT') AND has_schema_privilege($1,'public','USAGE') AND NOT has_schema_privilege($1,'public','CREATE') ok",[user])).rows[0];
    if(!access.ok) throw new Error(`${topic} requires CONNECT/USAGE without schema CREATE`);
    for(const table of tables) {
      const tableName=`public.${table}`;
      for(const privilege of ['SELECT','INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
        const actual=(await client.query('SELECT has_table_privilege($1,$2,$3) ok',[user,tableName,privilege])).rows[0].ok;
        const wanted=(privilege==='SELECT'?policy.select:privilege==='INSERT'?policy.insert:privilege==='DELETE'?(policy.delete??[]):[]).includes(table);
        if(actual!==wanted) throw new Error(`${topic} unexpected ${privilege} privilege on ${table}`);
      }
      const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
      for(const {column_name:column} of columns) {
        const allowed=policy.update[table];
        const wanted=allowed==='*'||Boolean(allowed?.includes(column));
        const actual=(await client.query("SELECT has_column_privilege($1,$2,$3,'UPDATE') ok",[user,tableName,column])).rows[0].ok;
        if(actual!==wanted) throw new Error(`${topic} unexpected UPDATE privilege on ${table}.${column}`);
      }
    }
    for(const routine of ['lock_order_creation_sources(uuid[],uuid)','apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)','guard_historical_order_reopen()']) {
      const actual=(await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[user,`public.${routine}`])).rows[0].ok;
      if(actual!==policy.execute.includes(routine)) throw new Error(`${topic} unexpected EXECUTE on ${routine}`);
    }
  }
  const connectorRoles=(await client.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'firebasereader_%' OR rolname LIKE 'firebasewriter_%'")).rows;
  if(connectorRoles.length<2) throw new Error('SQL Connect reader/writer roles not found');
  for(const {rolname:user} of connectorRoles) {
    const result=(await client.query(`SELECT has_table_privilege($1,'public.native_order_edit_context','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege($1,'public.native_order_edit_context','SELECT,INSERT,UPDATE,REFERENCES') OR
      has_function_privilege($1,'public.apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)','EXECUTE') exposed`,[user])).rows[0];
    if(result.exposed) throw new Error(`Private order edit access exposed to ${user}`);
    const {rows: [{historicalGuardExposed}]} = await client.query(
      `SELECT has_function_privilege($1,'public.guard_historical_order_reopen()','EXECUTE') AS "historicalGuardExposed"`, [user]);
    if(historicalGuardExposed) throw new Error(`Historical order guard execution exposed to ${user}`);
    const {rows: [{reportExposed}]} = await client.query(`SELECT EXISTS (
      SELECT 1 FROM unnest(ARRAY['public.report_entry','public.report_entry_change']) AS report(name)
      WHERE has_table_privilege($1,name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege($1,name,'SELECT,INSERT,UPDATE,REFERENCES')) AS "reportExposed"`,[user]);
    if(reportExposed) throw new Error(`Private Report data exposed to ${user}`);
  }
  const publicAccess=(await client.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
    LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='public'
    AND p.proname IN ('apply_native_order_edit','lock_order_creation_sources','guard_historical_order_reopen') AND a.grantee=0 AND a.privilege_type='EXECUTE') exposed`)).rows[0];
  if(publicAccess.exposed) throw new Error('Private helper execution granted to PUBLIC');
}
