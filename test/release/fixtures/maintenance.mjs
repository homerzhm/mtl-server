export async function up(client) {
  await client.query('CREATE TABLE IF NOT EXISTS mtl_operations.maintenance_probe(id integer PRIMARY KEY)');
  await client.query('INSERT INTO mtl_operations.maintenance_probe VALUES(1) ON CONFLICT DO NOTHING');
}
