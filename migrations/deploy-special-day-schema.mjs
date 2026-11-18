// These are the only native constraints that SQL Connect asks to change.
const nativeChecks = [
  ['customer_order', 'customer_order_values_check'],
  ['order_audit_event', 'order_audit_values_check'],
  ['order_capacity_allocation', 'capacity_values_check'],
  ['order_item', 'order_item_values_check'],
  ['payment', 'payment_values_check'],
  ['refund', 'refund_values_check'],
];
const nativeReferences = [
  ['customer_order', 'customer_order_client_id_fkey', 'SET NULL'],
  ['order_audit_event', 'order_audit_event_order_id_fkey', 'CASCADE'],
  ['order_item', 'order_item_capacity_group_id_fkey', 'SET NULL'],
  ['order_item', 'order_item_order_id_fkey', 'CASCADE'],
  ['order_item', 'order_item_product_id_fkey', 'CASCADE'],
  ['payment', 'payment_order_id_fkey', 'CASCADE'],
  ['refund', 'refund_payment_id_fkey', 'CASCADE'],
];
const pausedTables = ['capacity_group', 'client', 'product', ...nativeChecks.map(([table])=>table)];
const pause = 'mtl_special_day_schema_pause';
const snapshot = 'mtl_operations.special_day_constraint_snapshot';
const contextTable = 'public.native_order_edit_context';

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function createSpecialDayTable(client, owner, ordersRole, connectorRoles) {
  await transaction(client, async()=>{
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`CREATE TABLE IF NOT EXISTS public.special_day_rule (
        id uuid PRIMARY KEY,
        group_id uuid NOT NULL REFERENCES public.capacity_group(id) ON DELETE CASCADE,
        capacity_per_block integer NOT NULL,
        day_keys integer[] NOT NULL,
        revision integer NOT NULL,
        saved_revision integer NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "special_day_rule_groupId_idx" ON public.special_day_rule (group_id);
      CREATE INDEX IF NOT EXISTS "special_day_rule_groupId_savedRevision_idx" ON public.special_day_rule (group_id, saved_revision);
      CREATE UNIQUE INDEX IF NOT EXISTS "special_day_rule_savedRevision_uidx" ON public.special_day_rule (saved_revision)`);
    await client.query(`REVOKE ALL ON public.special_day_rule FROM PUBLIC;
      GRANT SELECT, INSERT, DELETE ON public.special_day_rule TO ${ordersRole};
      GRANT UPDATE(capacity_per_block, day_keys, revision, saved_revision, updated_at, updated_by)
        ON public.special_day_rule TO ${ordersRole}`);
    for (const {role} of connectorRoles) {
      await client.query(`REVOKE ALL ON public.special_day_rule FROM ${role};
        GRANT SELECT ON public.special_day_rule TO ${role}`);
    }
  });
}

async function pauseWrites(client, owner, connectorRoles) {
  await transaction(client, async()=>{
    // The snapshot and write guards commit together. A restarted release resumes
    // with those definitions if the previous process died during registration.
    if ((await client.query('SELECT to_regclass($1) AS snapshot',[snapshot])).rows[0].snapshot) return;
    await client.query(`CREATE TABLE ${snapshot} (name text PRIMARY KEY, definition text NOT NULL)`);
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`LOCK TABLE ${pausedTables.map(table=>`public.${table}`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const {rows:constraints} = await client.query(`SELECT conrelid::regclass::text AS table_name, conname AS name,
      contype AS type, convalidated AS validated, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname=ANY($1)`,
    [[...nativeChecks,...nativeReferences].map(([,name])=>name)]);
    for (const [table,name,onDelete] of [...nativeChecks,...nativeReferences]) {
      const matches=constraints.filter(c=>c.table_name===table&&c.name===name&&c.validated);
      if (matches.length!==1 || (onDelete ? matches[0].type!=='f'||!matches[0].definition.endsWith(' ON DELETE RESTRICT') : matches[0].type!=='c')) {
        throw new Error(`Unexpected native constraint ${table}.${name}`);
      }
    }
    await client.query(`CREATE FUNCTION public.${pause}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Order schema maintenance: retry later' USING ERRCODE='55000'; END $$`);
    for (const table of pausedTables) {
      await client.query(`CREATE TRIGGER ${pause} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${table}
        FOR EACH STATEMENT EXECUTE FUNCTION public.${pause}()`);
    }
    for (const {table_name:table,name,definition} of constraints) {
      const onDelete=nativeReferences.find(([,reference])=>reference===name)?.[2];
      await client.query(`ALTER TABLE public.${table} DROP CONSTRAINT ${name}${onDelete ?
        `, ADD CONSTRAINT ${name} ${definition.replace(/ ON DELETE RESTRICT$/,` ON DELETE ${onDelete}`)}` : ''}`);
    }
    for (const {role,context_select:canSelect} of connectorRoles) {
      if (canSelect) throw new Error('Unexpected existing connector access to the private edit context');
      await client.query(`GRANT SELECT ON ${contextTable} TO ${role}`);
    }
    await client.query('RESET ROLE');
    await client.query(`INSERT INTO ${snapshot} (name,definition)
      SELECT name,definition FROM jsonb_to_recordset($1::jsonb) AS c(name text,definition text)`,[JSON.stringify(constraints)]);
  });
}

async function restoreWrites(client, owner, connectorRoles) {
  await transaction(client, async()=>{
    const {rows:definitions} = await client.query(`SELECT name,definition FROM ${snapshot}`);
    const saved = new Map(definitions.map(({name,definition})=>[name,definition]));
    if (saved.size!==nativeChecks.length+nativeReferences.length) throw new Error('Native constraint snapshot is incomplete');
    await client.query(`SET LOCAL ROLE ${owner}`);
    for (const [table,name,onDelete] of [...nativeChecks,...nativeReferences]) {
      const definition=saved.get(name);
      if (!definition) throw new Error(`Missing native constraint snapshot for ${name}`);
      await client.query(`ALTER TABLE public.${table} ${onDelete ? `DROP CONSTRAINT ${name}, ` : ''}ADD CONSTRAINT ${name} ${definition}`);
    }
    for (const {role} of connectorRoles) await client.query(`REVOKE SELECT ON ${contextTable} FROM ${role}`);
    for (const table of pausedTables) await client.query(`DROP TRIGGER ${pause} ON public.${table}`);
    await client.query(`DROP FUNCTION public.${pause}()`);
    await client.query('RESET ROLE');
    await client.query(`DROP TABLE ${snapshot}`);
  });
}

export async function up(client, {firebase, parameters}) {
  if (!parameters?.ORDERS_SQL_USER) throw new Error('Missing Orders runtime identity');
  const {rows:[{owner,orders_role:ordersRole}]} = await client.query(`SELECT quote_ident(pg_get_userbyid(relowner)) AS owner,
    quote_ident($1) AS orders_role FROM pg_class WHERE oid='public.capacity_group'::regclass`,[parameters.ORDERS_SQL_USER]);
  const {rows:connectorRoles} = await client.query(`SELECT quote_ident(rolname) AS role,
    has_table_privilege(rolname,$1,'SELECT') AS context_select FROM pg_roles
    WHERE rolname IN ('firebasereader_restaurant_public','firebasewriter_restaurant_public')`,[contextTable]);
  await createSpecialDayTable(client,owner,ordersRole,connectorRoles);
  await pauseWrites(client,owner,connectorRoles);
  try {
    await firebase('deploy', ['--only', 'dataconnect:restaurant:schema', '--non-interactive']);
  } finally {
    await restoreWrites(client,owner,connectorRoles);
  }
}
