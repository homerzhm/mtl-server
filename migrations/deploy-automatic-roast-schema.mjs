import {up as registerCompatibleSchema} from './deploy-order-slip-schema.mjs';

async function prepare(client, owner, runtime) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(`SET LOCAL ROLE ${owner}`);
    await client.query(`ALTER TABLE public.customer_order
      ADD COLUMN IF NOT EXISTS roast_block_needed_reason text,
      ADD COLUMN IF NOT EXISTS price_override_cents integer;
      GRANT UPDATE(roast_block_needed_reason) ON public.customer_order TO ${runtime}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function up(client, context) {
  const ordersUser = context.parameters?.ORDERS_SQL_USER;
  if (!ordersUser) throw new Error('Missing Orders runtime identity');
  const {rows: [{owner, runtime}]} = await client.query(`
    SELECT quote_ident(pg_get_userbyid(relowner)) AS owner, quote_ident($1) AS runtime
    FROM pg_class WHERE oid='public.customer_order'::regclass`, [ordersUser]);
  await prepare(client, owner, runtime);
  await registerCompatibleSchema(client, context);
  await prepare(client, owner, runtime);
}
