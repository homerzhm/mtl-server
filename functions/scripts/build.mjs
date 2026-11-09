import {rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

// Remove obsolete compiled modules when topics or entrypoints move.
const root = new URL('../', import.meta.url);
rmSync(new URL('lib/', root), {recursive:true, force:true});
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc')], {cwd:root, stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
