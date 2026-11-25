import {up as registerCompatibleSchema} from './deploy-report-schema.mjs';

const snapshot = 'mtl_operations.order_slip_schema_check_snapshot';
const pause = 'mtl_order_slip_schema_pause';
const privateChecks = [
  ['report_entry', 'report_entry_values_check'],
  ['report_entry_change', 'report_entry_change_values_check'],
  ['order_slip_task', 'order_slip_task_state_valid'],
];

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

async function pausePrivateWrites(client, owner) {
  await transaction(client, async () => {
    if ((await client.query('SELECT to_regclass($1) AS snapshot', [snapshot])).rows[0].snapshot) return;
    await client.query(`CREATE TABLE ${snapshot} (name text PRIMARY KEY, definition text NOT NULL)`);
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`LOCK TABLE ${privateChecks.map(([table]) => `public.${table}`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const {rows: checks} = await client.query(`
      SELECT conrelid::regclass::text AS table_name, conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE contype='c' AND convalidated AND connamespace='public'::regnamespace
      AND conname=ANY($1)`, [privateChecks.map(([,name]) => name)]);
    await client.query(`CREATE FUNCTION public.${pause}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Private schema maintenance: retry later' USING ERRCODE='55000'; END $$`);
    for (const [table, name] of privateChecks) {
      await client.query(`CREATE TRIGGER ${pause} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
        ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION public.${pause}()`);
      const saved = checks.find(check => check.table_name === table && check.name === name);
      if (saved) await client.query(`ALTER TABLE public.${table} DROP CONSTRAINT ${name}`);
    }
    await client.query('RESET ROLE');
    await client.query(`INSERT INTO ${snapshot} (name,definition)
      SELECT name,definition FROM jsonb_to_recordset($1::jsonb) AS saved(name text,definition text)`, [JSON.stringify(checks)]);
  });
}

async function restorePrivateWrites(client, owner) {
  await transaction(client, async () => {
    if (!(await client.query('SELECT to_regclass($1) AS snapshot', [snapshot])).rows[0].snapshot) return;
    const {rows: checks} = await client.query(`SELECT name,definition FROM ${snapshot}`);
    await client.query(`SET LOCAL ROLE ${owner}`);
    for (const [table, name] of privateChecks) {
      const saved = checks.find(check => check.name === name);
      if (saved) await client.query(`ALTER TABLE public.${table} ADD CONSTRAINT ${name} ${saved.definition}`);
      await client.query(`DROP TRIGGER ${pause} ON public.${table}`);
    }
    await client.query(`DROP FUNCTION public.${pause}()`);
    await client.query('RESET ROLE');
    await client.query(`DROP TABLE ${snapshot}`);
  });
}

export async function up(client, context) {
  if (!context.parameters?.SLIPS_SQL_USER) throw new Error('Missing Slips runtime identity');
  const {rows: [{owner, runtime}]} = await client.query(`
    SELECT quote_ident(pg_get_userbyid(relowner)) AS owner, quote_ident($1) AS runtime
    FROM pg_class WHERE oid='public.product'::regclass`, [context.parameters.SLIPS_SQL_USER]);

  const privileges = (schemaAccess, allRoles) => transaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${owner}`);
    const {rows} = await client.query(`SELECT quote_ident(rolname) AS role FROM pg_roles
      WHERE rolname LIKE 'firebasereader_%' OR rolname LIKE 'firebasewriter_%'`);
    for (const role of ['PUBLIC', ...rows.map(row => row.role)]) {
      await client.query(`REVOKE ALL ON public.order_slip_task FROM ${role}`);
      if (schemaAccess && ['firebasereader_restaurant_public', 'firebasewriter_restaurant_public'].includes(role)) {
        await client.query(`GRANT REFERENCES ON public.order_slip_task TO ${role}`);
      }
    }
    if (allRoles) {
      await client.query(`GRANT SELECT, INSERT, DELETE ON public.order_slip_task TO ${runtime};
        GRANT UPDATE(status,preview,failure_code,updated_at,available_at,dispatch_generation,dispatched_at,
          attempts,lease_token,lease_until) ON public.order_slip_task TO ${runtime};
        GRANT SELECT(id,name,chinese_name,is_active) ON public.product TO ${runtime}`);
    }
  });

  await transaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`CREATE TABLE IF NOT EXISTS public.order_slip_task (
      id uuid PRIMARY KEY, actor_uid text NOT NULL, checksum text NOT NULL, object_key text NOT NULL,
      object_generation text NOT NULL, provider text NOT NULL, model text NOT NULL, status text NOT NULL,
      preview jsonb, failure_code text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL, available_at timestamptz NOT NULL, dispatch_generation integer NOT NULL,
      dispatched_at timestamptz, attempts integer NOT NULL, lease_token uuid, lease_until timestamptz
    );
    CREATE INDEX IF NOT EXISTS "order_slip_task_createdAt_id_idx" ON public.order_slip_task(created_at,id);
    CREATE INDEX IF NOT EXISTS "order_slip_task_status_availableAt_idx" ON public.order_slip_task(status,available_at);
    CREATE INDEX IF NOT EXISTS "order_slip_task_expiresAt_idx" ON public.order_slip_task(expires_at);
    REVOKE ALL ON public.order_slip_task FROM PUBLIC`);
  });
  await restorePrivateWrites(client, owner);
  await privileges(false, true);
  try {
    await registerCompatibleSchema(client, {...context, firebase: async (...args) => {
      try {
        await pausePrivateWrites(client, owner);
        await privileges(true, false);
        await context.firebase(...args);
      } finally {
        await restorePrivateWrites(client, owner);
      }
    }});
  } finally {
    await privileges(false, false);
  }
}
