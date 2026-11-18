import {up as registerCompatibleSchema} from './deploy-special-day-schema.mjs';

const specialDaySnapshot = 'mtl_operations.report_schema_special_day_snapshot';

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

async function revokeConnectorAccess(client) {
  const {rows: connectorRoles} = await client.query(`
    SELECT quote_ident(rolname) AS role FROM pg_roles
    WHERE rolname LIKE 'firebasereader_%' OR rolname LIKE 'firebasewriter_%'`);
  for (const role of ['PUBLIC', ...connectorRoles.map(row => row.role)]) {
    await client.query(`REVOKE ALL ON public.report_entry, public.report_entry_change FROM ${role}`);
  }
}

async function pauseSpecialDayWrites(client, owner) {
  await transaction(client, async () => {
    if ((await client.query('SELECT to_regclass($1) AS snapshot', [specialDaySnapshot])).rows[0].snapshot) return;
    await client.query(`CREATE TABLE ${specialDaySnapshot} (definition text NOT NULL)`);
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query('LOCK TABLE public.special_day_rule IN ACCESS EXCLUSIVE MODE');
    const {rows: [check]} = await client.query(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.special_day_rule'::regclass AND conname='special_day_rule_values_valid'
        AND contype='c' AND convalidated`);
    if (!check) throw new Error('Missing validated special-day rule constraint');
    await client.query(`
      CREATE TRIGGER mtl_report_schema_pause BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public.special_day_rule FOR EACH STATEMENT EXECUTE FUNCTION public.mtl_special_day_schema_pause();
      ALTER TABLE public.special_day_rule DROP CONSTRAINT special_day_rule_values_valid`);
    await client.query('RESET ROLE');
    await client.query(`INSERT INTO ${specialDaySnapshot} (definition) VALUES ($1)`, [check.definition]);
  });
}

async function restoreSpecialDayWrites(client, owner) {
  await transaction(client, async () => {
    if (!(await client.query('SELECT to_regclass($1) AS snapshot', [specialDaySnapshot])).rows[0].snapshot) return;
    const {rows: [check]} = await client.query(`SELECT definition FROM ${specialDaySnapshot}`);
    if (!check) throw new Error('Missing special-day rule constraint snapshot');
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`
      ALTER TABLE public.special_day_rule ADD CONSTRAINT special_day_rule_values_valid ${check.definition};
      DROP TRIGGER mtl_report_schema_pause ON public.special_day_rule`);
    await client.query('RESET ROLE');
    await client.query(`DROP TABLE ${specialDaySnapshot}`);
  });
}

// Prepare only the new tables. The shared schema is registered through the
// existing guarded maintenance so native order protections are restored.
export async function up(client, context) {
  const reportUser = context.parameters?.REPORT_SQL_USER;
  if (!reportUser) throw new Error('Missing Report runtime identity');
  const {rows: [{owner, runtime}]} = await client.query(`
    SELECT quote_ident(pg_get_userbyid(relowner)) AS owner, quote_ident($1) AS runtime
    FROM pg_class WHERE oid='public.capacity_group'::regclass`, [reportUser]);
  await transaction(client, async () => {
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.report_entry (
        id uuid PRIMARY KEY, day date NOT NULL, type text NOT NULL, amount_cents integer NOT NULL,
        notes text, creator_uid text NOT NULL, entered_by text NOT NULL, entered_at timestamptz NOT NULL,
        revision integer NOT NULL, deleted_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS "report_entry_day_id_idx" ON public.report_entry(day,id);
      CREATE TABLE IF NOT EXISTS public.report_entry_change (
        id uuid PRIMARY KEY, entry_id uuid NOT NULL REFERENCES public.report_entry(id) ON DELETE CASCADE,
        revision integer NOT NULL, operation text NOT NULL, actor_uid text NOT NULL, actor_name text NOT NULL,
        occurred_at timestamptz NOT NULL, payload_hash text NOT NULL, snapshot jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "report_entry_change_entryId_idx" ON public.report_entry_change(entry_id);
      CREATE UNIQUE INDEX IF NOT EXISTS "report_entry_change_entryId_revision_uidx"
        ON public.report_entry_change(entry_id,revision);
      GRANT SELECT, INSERT ON public.report_entry, public.report_entry_change TO ${runtime};
      GRANT UPDATE(amount_cents,notes,revision,deleted_at) ON public.report_entry TO ${runtime}`);
    await revokeConnectorAccess(client);
  });

  try {
    await registerCompatibleSchema(client, {...context, firebase: async (...args) => {
      try {
        await pauseSpecialDayWrites(client, owner);
        await transaction(client, async () => {
          await client.query(`SET LOCAL ROLE ${owner}`);
          // Expose the table definitions to schema validation without Report DML access.
          const {rows: roles} = await client.query(`SELECT quote_ident(rolname) AS role FROM pg_roles
            WHERE rolname IN ('firebasereader_restaurant_public', 'firebasewriter_restaurant_public')`);
          for (const {role} of roles) {
            await client.query(`GRANT REFERENCES ON public.report_entry, public.report_entry_change TO ${role}`);
          }
        });
        await context.firebase(...args);
      } finally {
        await restoreSpecialDayWrites(client, owner);
      }
    }});
  } finally {
    await transaction(client, async () => {
      await client.query(`SET LOCAL ROLE ${owner}`);
      await revokeConnectorAccess(client);
    });
  }
}
