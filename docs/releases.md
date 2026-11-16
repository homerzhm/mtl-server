# Dev-first releases

The supported release entrypoint always selects dev unless `--environment production`
is supplied. It never reads the Firebase CLI's remembered active project. Every cloud
command receives a full project ID and an environment-specific generated config.
Direct Firebase/gcloud commands bypass these repo defaults; always pass `--project`.

## Daily workflow

Use native Node 22, npm and a current Firebase CLI. Install locked dependencies with
`npm ci` and `npm --prefix functions ci`. The operator tools reuse modules pinned in
`functions/package-lock.json`; they are separate from cloud trigger exports.

1. Implement locally, update `release/manifest.json`, run local tests and commit.
   Keep the checkout clean. The default manifest deploys the connector and all seven
   existing server Functions; it does not deploy the hardened GraphQL schema.
2. Run `npm run deploy`. This deploys to `mtl-service-e3e0c`.
3. Verify business behavior in dev using designated accounts/orders. Run
   `npm run release:verify -- --accept-dev` to attest that acceptance. The command
   also performs reproducible dependency installation, all local checks, read-only
   deployed source/runtime/SQL checks, and records the exact commit and resources.
4. From the same clean commit, run
   `npm run deploy -- --environment production`.

Production is `mtl-service-production`. No code, schema or connector copies are
maintained. The generated `.firebase-release-<environment>-<pid>.json` and ignored
`.firebase/releases/<environment>-<pid>/dataconnect.yaml` select each SQL instance while
using disposable snapshots of the original schema and connector directories.
The compiler requires sources inside its service directory; these ignored files
are regenerated on each invocation and are never maintained or edited separately.
Each process gets its own staging path so a concurrent invocation cannot change an
active compiler’s inputs.

Preview either release without cloud access or mutations:

```sh
npm run deploy -- --dry-run
npm run deploy -- --environment production --dry-run
```

Preview prints the current commit, projects, scopes and checksums. It deliberately
allows an uncommitted checkout for inspecting work; execution requires a clean one.
Runtime parameters, database baselines and promotion eligibility are checked only
when actually executing. Deployment commands are explicit operator actions; running
tests or changing configuration never deploys.

### Operator configuration

Create ignored `functions/.env.mtl-service-e3e0c` and
`functions/.env.mtl-service-production`, with exactly these eight parameters:

```dotenv
STAFF_SQL_INSTANCE=mtl-service-production:northamerica-northeast1:mtl-restaurant-production
STAFF_SQL_DATABASE=restaurant
STAFF_RUNTIME_SERVICE_ACCOUNT=mtl-staff-functions@mtl-service-production.iam.gserviceaccount.com
STAFF_SQL_USER=mtl-staff-functions@mtl-service-production.iam
ORDERS_SQL_INSTANCE=mtl-service-production:northamerica-northeast1:mtl-restaurant-production
ORDERS_SQL_DATABASE=restaurant
ORDERS_RUNTIME_SERVICE_ACCOUNT=mtl-orders-functions@mtl-service-production.iam.gserviceaccount.com
ORDERS_SQL_USER=mtl-orders-functions@mtl-service-production.iam
```

Use the actual service account names; the two identities must differ and belong to
the selected project. IAM SQL usernames omit `.gserviceaccount.com`. Never place
operator identities in these runtime files. Generic `.env`, `.env.default` and
selected environment alias files are rejected because Firebase merges them.
Emulator-only `.env.local` remains available for local development.

Configure operator Application Default Credentials and set these shell values:

```sh
export MTL_RELEASE_DEV_SQL_USER='your-dev-operator-iam-login'
export MTL_RELEASE_PRODUCTION_SQL_USER='your-production-operator-iam-login'
```

Both release operators must correspond to the credentials used by the Cloud SQL
connector. The same ADC identity needs authorized access to both projects for
promotion, or use an authorized impersonated identity with access to both. This is
operator access, never a runtime grant. No password/connection-URL override exists.
Release commands reject emulator override variables.

The operator needs Cloud SQL Client/Instance User, appropriate database migration
ownership/DDL rights, exclusive access to `mtl_operations`, read access to SQL
Connect/Functions/Scheduler/SQL instance metadata, and deployment/actAs permissions
for the chosen components. Firebase deployment authentication and ADC may differ:
configure both deliberately. No role changes are automatically granted by tooling.

Set `MTL_FIREBASE_CLI` to an absolute `firebase-tools/lib/bin/firebase.js` path if
the global Firebase executable uses a different Node installation. Child npm/node
commands must resolve to native Node 22 through PATH.

## Release manifests and database changes

The manifest lists ordered native migrations, affected components and the fixed
verification suite. Initial migrations are `baselineOnly`: routine deployment never
reapplies them to an existing populated database. Retain all historical entries.
The database ledger checks file/mode/procedure/verification checksums and applied
prefix order. Never edit an applied migration; append a new immutable entry.

For a new transactional migration:

```json
{
  "id": "007-example-change",
  "file": "migrations/example-change.sql",
  "mode": "transaction",
  "verify": "migrations/verify-example-change.sql"
}
```

The SQL file must contain one outer `BEGIN; ... COMMIT;`. The runner folds that
pair into its own transaction so DDL, assertions and ledger recording commit
atomically. The verification file is one SELECT returning exactly one `ok: true`
row. It must be a side-effect-free assertion, not a data-changing function call.
Migration authors must test this behavior in disposable PostgreSQL.

For schema changes, include `schema` in components and set `schemaMaintenance` to
the ID of an appended `mode: "maintenance"` migration. Its `file` is an ES module
exporting `async up(client, context)`; supply `idempotent: true`, a `procedure` path
to reviewed operator instructions, and a verification SELECT file. All files are
checksummed. The context contains `target`, generated `config`, and
`firebase(command, args)` which pins project/config. This reviewed module owns the
required maintenance transactions, write guards, native protection preservation,
explicit schema deployment, restoration, and interrupted-state recovery. It must
leave the connection outside a transaction on return or error. It must not import
cloud trigger modules. Add integration tests for every new maintenance procedure.

There is intentionally no generic generated-schema SQL executor. Do not apply a
hardened-database diff wholesale or use `--force`. Automatic schema deployment is
only possible inside that release's reviewed maintenance module. A standalone
schema source change without a schema component is rejected. Unchanged schemas
are read-only checked before routine deployment.

Any entry marked `destructive: true` is blocked from routine release. Review its
compatibility and preservation strategy separately; there is no bypass switch.
Keep `COMPATIBLE`, audit immutability, historical allocations, private context
permissions and least-privilege runtime access throughout maintenance.

`release/database-contract.json` is the reviewed minimum object-definition
contract captured from a fresh local schema plus native migrations. It checks
columns/defaults/nullability, indexes, constraints, triggers (including enabled
state), and non-extension routines (including security-definer/search-path
settings). Additional live objects are reported by audit rather than dropped.
A PostgreSQL-version-dependent definition mismatch requires human investigation;
never weaken the checks automatically to make a deployment pass.

To intentionally regenerate that artifact after an approved schema/native change:

```sh
node scripts/release/test-integration.mjs --write-contract
```

Review the resulting diff with the corresponding migration. This local authoring
command never connects to a cloud database.

### Verification and retries

A session advisory lock serializes releases, audits, baselines and acceptance.
Promotion holds dev's lock before taking production's lock, preventing managed dev
changes while promoting. Migration records live in operator-owned
`mtl_operations.migration`, release outcomes in `mtl_operations.release`.

Completed connector/Functions stages retain resource fingerprints. On retry they
are read-only checked and skipped; unfinished stages run again. A command may
have committed remotely before its response was lost: a stage without a successful
record is redeployed from the same commit. Database transactional migrations commit
with their ledger record; nontransactional maintenance must resume idempotently.
Failed releases remain `failed`; they do not count as deployed or verified.

Read-only checks compare deployed schema/connector source with the checkout;
check the full Functions inventory, ACTIVE state, runtime, identity, parameters,
timeouts/scaling limits; check the reconciliation schedule and Cloud SQL IAM flag;
and verify native database definitions and effective runtime/private permissions.
Production additionally requires enabled backups and point-in-time recovery.
Function build/update metadata is fingerprinted to detect changes after acceptance.
The scheduler fingerprint excludes run timestamps, which change every minute.
These checks do not create payments/orders or substitute for staff workflow acceptance.

Do not deploy another dev release between acceptance and promotion: production
requires the latest managed dev release and unchanged resource fingerprint. There
is no automatic rollback across database and cloud components. On failure, inspect
the stage/SQL state and fix forward; do not reset the ledger or alter checksums to
skip work. To retry a failed unrecorded stage, rerun the same command/commit.
For an externally modified completed stage, investigate and reconcile explicitly
with the release operator before starting a new reviewed release.

## One-time readiness and baseline

Both existing dev and new production must be audited and baselined before the
normal workflow works. Baseline adoption never replays the native SQL files.
Do this only after an explicit cloud setup/deployment request.

1. Inspect the target project's existing resources first. Production defaults to
   `mtl-restaurant-production` only if no instance has already been selected.
   Set the actual mapping in `release/environments.json` before the first commit
   accepted in dev. Match PostgreSQL version/flags deliberately; production sizing
   and high availability may exceed dev. Retain three reserved connections plus
   room for fourteen pooled runtime connections and operator sessions.
2. Configure billing, budget alerts, required APIs (SQL Connect, Cloud SQL Admin,
   Auth/Identity Toolkit, Functions/Run, Build, Artifact Registry and Scheduler),
   monitoring/alerts, backups/PITR, recovery retention and a restore drill. Inspect
   IAM and network access, not just the Firebase console project settings.
3. Enable Google Auth, register production iOS and its sign-in configuration.
   Keep app configuration separate from dev. No dev Auth identities, claims or
   business data are imported. The iOS target/configuration change is separate.
4. Create dedicated Staff and Orders runtime identities and IAM database users.
   Apply the exact current topic grants in staff-management/live-order-booking,
   including subsequent action/payment/edit grants. Staff alone needs Auth
   get/list/update privileges. Orders must have no Auth administration, product or
   client UPDATE, private-context DML, or unrelated Staff-table access.
5. Create the ignored parameter file and run
   `npm run release:config -- --environment production`. It generates a local
   Firebase config path without cloud access. Use that printed config path and an explicit
   `--config` and `--project mtl-service-production` on every provisioning command.
6. For a **new empty** database only, review the SQL diff, apply the current
   generated schema and deploy it before native hardening. Keep business access
   closed during setup. Install the native SQL in this order:
   `order-integrity`, `order-paid-status`, `order-capacity-booking`, `order-actions`,
   `payment-edits`, `order-edits`. Apply grants and verify effective private access.
   Do not reuse this fresh-database schema procedure on populated dev.
7. Deploy the matching connector and all seven Functions to initialize the cloud
   resources. Confirm scheduler readiness. Bootstrap an explicit production Google
   UID using the trusted Staff setup command with production operator parameters;
   it uses shell parameters, not automatic dotenv loading. Preserve genuine admin
   history. Create no sample products, clients, groups, orders, or financial rows.
8. As the trusted database operator, execute `release/operations.sql`. It creates
   only private release metadata, with PUBLIC access revoked. Ensure no runtime,
   connector, group or inherited role has schema/table/column privileges there.
   It is deliberately outside SQL Connect's application schema.
9. Run `npm run release:audit -- --environment production --expect-empty` and review
   the catalog/grant output and the checklist above. Then run
   `npm run release:baseline -- --environment production --expect-empty`.
   Baseline verifies actual objects/resources and records native checksums only;
   it never asserts that code was deployed from this commit.
10. Audit and baseline existing dev with `npm run release:baseline` (no
    `--expect-empty`, because its business rows are retained). Deploy and verify
    the new managed dev release, then promote it to production. The first managed
    release must deploy both Functions and connector even after baseline adoption.

Initial production baseline requires all business/request/private-edit tables to
be empty. Permitted system state is the booking schedule and intentional staff
bootstrap/control/history. Never remove real audit history merely to satisfy an
empty-database check. Groups/limits are configured explicitly by administrators
when real business setup begins; there is no booking activation flag or gate.

The SQL Connect hardened-schema mismatch may expose old generated/default/index
naming differences during baseline. Capture `release:audit` output and reconcile
through reviewed compatible maintenance; do not force schema migration or seed
ledger records without passing verification.

## Local checks

```sh
npm test
npm run test:releases
firebase emulators:exec --only dataconnect --project demo-mtl "true"
npm --prefix functions test
npm --prefix functions run test:emulators
```

The release integration runner uses disposable PostgreSQL on 15433 and SQL Connect
on 9399; Functions integration uses PostgreSQL on 15432 and SQL Connect on 9399.
Run those suites sequentially. All targets are loopback/demo-mtl. The Functions
integration runner also runs all four connector suites. Release tests exercise
empty initialization, native guards/grants, locks, checksums, failed migrations,
idempotent maintenance, partial component retries and promotion rejection.
