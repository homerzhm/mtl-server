import assert from 'node:assert/strict';
const args=process.argv.slice(2);
assert.deepEqual(args,['deploy','--project','mtl-service-e3e0c','--config','fake-config.json','--only','functions:server']);
// A remembered/global project must not affect the wrapper's explicit selection.
assert.equal(process.env.GCLOUD_PROJECT,'mtl-service-production');
