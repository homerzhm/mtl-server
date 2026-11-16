// Explicit local authoring tool. Never run by deployment or normal tests.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from '../../test/release/fixture.mjs';
import {inventory} from './database.mjs';
import {root} from './config.mjs';
const client=await fixture();
try {
  await writeFile(join(root,'release/database-contract.json'),JSON.stringify(await inventory(client),null,2)+'\n');
  console.log('Captured database contract from fresh local schema and native migrations. Review before committing.');
} finally {await client.end();}
