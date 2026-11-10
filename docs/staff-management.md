# Staff profiles and role management

The server is deployed to dev (`mtl-service-e3e0c`). iOS integration is a separate
step. Existing product, client, and order authorization expressions are unchanged.

The Functions package uses the `server` codebase. Staff handlers, business service,
database configuration and trusted setup entrypoint live in `functions/src/staff/`.
The root `index.ts` exports the existing trigger names unchanged. Each future
topic gets its own folder and runtime settings; shared infrastructure lives in
`functions/src/shared/`. Staff's database pool and role-control lock are scoped to
staff operations. Each Staff trigger uses maxInstances 1, concurrency 2 and a
two-connection pool. Together with Orders, all four triggers reserve at most eight
pooled connections against dev's 25-connection limit (three reserved). Review the
combined budget before scaling. Follow the Functions conventions in `AGENTS.md`
when adding topics.

## Accounts and permissions

`StaffAccount` uses the Firebase Auth UID as its permanent key. `name`, `email`,
and `photoUrl` come from the linked Google provider through the Admin SDK and are
nullable. They are refreshed at registration; the caller cannot supply them.
There are no phone, payroll, employment, manual profile-edit, or delete operations.

Staff and Admin are independent Boolean switches:

| Staff | Admin | Access |
| --- | --- | --- |
| false | false | Pending approval; own staff profile only through the new interfaces |
| true | false | Staff directory; existing staff permissions |
| false | true | Staff directory, admin account list and role management; existing admin permissions |
| true | true | Both sets of permissions, including product editing |

Existing product reads still accept any authenticated user. Product writes still
require both claims. Client and order permissions still accept either claim,
with admin-only order operations retaining their existing restrictions.

`createdAt` is first registration/import time. `lastSignInAt` is the greatest
Firebase Auth `metadata.lastSignInTime` observed during registration. It is
nullable for imports without sign-in metadata and does not track online presence.
An account with both switches off remains in the admin list, including after
removal of previously granted roles.

All new client interfaces require Google sign-in. Staff directory/admin list
authorization uses strict Boolean Firebase claims, so stale tokens retain their
read permissions until refreshed. Role changes additionally check the actor's
current database Admin flag and current Auth record. Clients have no connector
mutation that can change profiles, roles, control state, or history.

## Callable contract

Functions are in `northamerica-northeast1` and use the Firebase callable protocol.
Use the Functions client SDK rather than manually handling bearer tokens.

- `registerStaffSignIn({})`: call after Google authentication, **before** deciding
  whether to let the user enter the staff app. Creates a pending account or updates
  Google profile/sign-in metadata. Never imports roles from request data or token
  claims. Rejects supplied fields. Existing account roles and revision are preserved.
- `setStaffRoles({uid, isStaff, isAdmin, expectedRevision})`: admin-only full role
  replacement. All four fields are required; flags must be Booleans. Use the
  revision returned by the admin account list. Repeated identical roles with the
  current revision are a no-op. A successful change increments revision once.

Both return an account directly through the SDK: `uid`, nullable `name`, `email`,
`photoUrl`, `isStaff`, `isAdmin`, `revision`, `claimSyncStatus`, `createdAt`, and
nullable `lastSignInAt`. Callable timestamps are ISO strings.

`claimSyncStatus` is `PENDING`, `APPLIED`, or `FAILED`. `APPLIED` means the new
claims were written to Firebase Auth; it does **not** mean all existing ID tokens
have refreshed. `FAILED` is a saved request awaiting retry, not a rolled-back
role edit. The role flags in the table show the requested state. Existing business
operations continue to authorize against the claims in their caller's ID token.
Refreshing the account list is required after a timeout or uncertain result.

Errors include `unauthenticated`, `permission-denied`, `invalid-argument`,
`not-found`, `aborted` / `STAFF_CONFLICT`, and `failed-precondition` with
`STAFF_SYNC_PENDING`, `STAFF_SELF_DEMOTION`, or `STAFF_LAST_ADMIN`. Unknown backend
failures return `internal` without exposing database or Auth error details.

## Connector reads

- `GetMyStaffAccount`: no UID argument, returns only the caller's profile or null;
  includes role flags and sync status, excludes management timestamps/revision.
- `ListStaffDirectory(offset = 0)`: accounts with either role; returns only UID,
  name, email, photo URL, and both role flags.
- `ListStaffAccounts(offset = 0)`: admin-only, includes pending users and all
  account fields, including creation/sign-in times, revision and sync status.
- `ListStaffRoleChanges(uid, offset = 0)`: admin-only history for one target, with
  actor, before/after flags, role revision, time, attempts, sanitized error code,
  synchronization status and applied timestamp.

Pages contain at most 100 rows; advance offsets by 100 until a short page.
Account lists sort by creation time then UID; history sorts by target revision.
Refetch lists when accounts or roles change; offset pages are not a shared snapshot.

## Durable synchronization

Every role change, import and bootstrap locks singleton `StaffRoleControl('roles')`.
The request transaction checks the current actor, target revision and admin safety,
then saves desired roles, an audit row, and the control record's pending change ID.
No other role change is accepted while that ID remains set, including after failure.
Admins cannot remove their own Admin flag. Concurrent demotions cannot leave zero
stored admins.

The synchronizer locks the same control row, reads the pending event, fetches the
target's current Auth claims, merges only `staff`/`admin`, and writes them. It holds
the lock through Auth processing and database finalization. On success it marks
the event/account applied and clears the pointer. On failure it records a failed
attempt and keeps the pointer. A crash after the Auth write leaves the durable
request replayable with the same role revision. Reconciliation is idempotent.

`reconcileStaffRoles` runs every minute; overlapping workers serialize through the
database. It logs failures and throws so scheduled retries also occur. Alert on
that function's errors and investigate accounts that remain pending/failed.
A deleted Auth target can leave a failed request blocking later role changes;
restore that Auth identity with the same UID or use a reviewed trusted repair
procedure to resolve the event. Do not simply clear the control pointer.

Role writes use direct PostgreSQL transactions because the lock must span the
external Auth call. Production uses the Cloud SQL Node connector with automatic
IAM database authentication, without a stored database password. Do not add
short database idle-in-transaction timeouts that could release the lock during
the Auth call. Keep this backend as the sole writer of staff/admin claims; manual
claim edits and table edits can cause drift. Unrelated claims are preserved as
observed immediately before each write.

## Local verification

Use native Node 22 and a current Firebase CLI, then from the server directory:

```sh
npm --prefix functions ci
npm --prefix functions test
npm --prefix functions run test:emulators
```

The integration runner starts disposable native PostgreSQL on loopback port 15432,
and Auth (9099), Functions (5001), and SQL Connect (9399) emulators for `demo-mtl`.
It runs the new backend/callable/directory tests plus existing product, client,
and order suites. It supplies only local test configuration, stops PostgreSQL,
and removes its temporary directory afterward. Keep these ports free. PostgreSQL
cannot run as root; use a normal development/CI user. The embedded PostgreSQL npm
package requires its platform binary post-install scripts.

For a CLI installed elsewhere, set `MTL_FIREBASE_CLI` to its JavaScript entrypoint.
The runner invokes it with the same native Node runtime. Schema-only validation
remains:

```sh
firebase emulators:exec --only dataconnect --project demo-mtl "true"
```

The local database override is rejected unless the project is `demo-mtl`, the Auth
emulator is configured, and the database hostname is loopback. Emulator mode
without that override fails closed rather than connecting to cloud SQL.

## Trusted setup and release procedure

Do not deploy automatically. Keep `schemaValidation: COMPATIBLE`. The existing
order database contains native constraints and immutable audit triggers that the
generated SQL diff can propose removing. Do **not** run forced schema migration.

For a requested dev release:

1. Review `firebase dataconnect:sql:diff --project dev`. Apply only the reviewed
   additive staff tables/indexes through a trusted PostgreSQL connection. Follow
   the existing hardened-database maintenance procedure for schema deployment;
   preserve all existing order constraints and keep audit triggers enabled.
   Verify native protections before and after. Do not deploy a connector that
   references the new tables until they exist.
2. Prepare a dedicated Functions runtime service account. Enable Cloud SQL IAM
   database authentication, add that IAM service account as a PostgreSQL user, and
   grant Cloud SQL Client, Cloud SQL Instance User, and the Firebase Auth user
   get/list/update permissions needed by this backend. The deploying identity
   also needs permission to act as the runtime service account. Enable the
   Functions/Scheduler/Cloud SQL APIs required for deployment.
3. Grant the runtime database user `CONNECT` on `restaurant`, `USAGE` on `public`,
   and `SELECT, INSERT, UPDATE` only on `public.staff_account`,
   `public.staff_role_change`, and `public.staff_role_control`. It needs no access
   to client/product/order tables, schema ownership, deletion or DDL. Audit and
   control records are retained by the backend.
4. Configure ignored `functions/.env.mtl-service-e3e0c` using `.env.example`:
   `STAFF_SQL_INSTANCE`, `STAFF_SQL_USER`, `STAFF_SQL_DATABASE`, and
   `STAFF_RUNTIME_SERVICE_ACCOUNT`. The SQL username for an IAM service account
   omits `.gserviceaccount.com`; the runtime identity parameter uses the complete
   email. Verify that IAM identity and PostgreSQL user match. No passwords or
   credential files belong in this repository.
5. **Before enabling registration in iOS**, run trusted setup to import existing
   Google accounts with Boolean staff/admin grants. Setup uses operator ADC and
   shell environment parameters, not automatic loading of Functions dotenv files.
   The operator must have Auth get/list/update privileges and an IAM database user
   matching its ADC identity (or use authorized service-account impersonation).
   Every cloud command must explicitly identify its project:

   ```sh
   npm --prefix functions run build
   npm --prefix functions run staff:setup -- --project mtl-service-e3e0c
   ```

   Setup imports only missing profiles, preserving existing rows and Auth claims.
   Imports create history at revision 0 and are repeatable. Accounts with neither
   role, disabled users and non-Google users are not imported. If no admin exists,
   the command fails and requires an explicit UID:

   ```sh
   npm --prefix functions run staff:setup -- --project mtl-service-e3e0c --bootstrap-admin FIREBASE_UID
   ```

   Bootstrap grants both flags to that existing Google user, records a durable
   audited change, and synchronizes claims. It never selects an account itself.
   If an existing imported user's row disagrees with its claims, setup fails with
   `STAFF_IMPORT_CONFLICT`; investigate before release rather than overwriting it.
   Recover interrupted synchronization:

   ```sh
   npm --prefix functions run staff:setup -- --project mtl-service-e3e0c --reconcile
   ```

6. Deploy only the requested connector and new Functions codebase after schema
   readiness and setup verification:

   ```sh
   firebase deploy --only dataconnect:restaurant:staff-admin,functions:server --project dev
   ```

   Review Functions deployment output to ensure the minute reconciliation job is
   created. Verify pending registration, admin role assignment, token refresh,
   ordinary directory access and role removal using designated test identities.
   Cloud testing/account creation is a separate explicit action; local tests do
   not create cloud users. Generate/copy the Swift SDK using the README procedure
   when implementing iOS. Production is not included in this release procedure.

## Later iOS work

Register immediately after Google sign-in, before the current staff-claim gate.
On failure, present a retry instead of assuming approval. A pending user sees an
approval screen with a “Check access” action that forces ID-token refresh and
reloads their profile. Let Admin-only accounts enter the app. Use token claims for
business authorization/UI capability checks and profile flags/sync status for
management display; do not imply desired roles already propagated to every device.

Replace sample directory data with `ListStaffDirectory`; show both role badges
independently. Admins use `ListStaffAccounts` and the callable role editor, passing
the loaded revision. Hide self-demotion and show pending/failed synchronization.
Refresh after conflicts and uncertain network results before submitting another
change. Force-refresh the target user's ID token on access checks or re-login;
the admin's device cannot force another device to refresh.

References: [custom claims](https://firebase.google.com/docs/auth/admin/custom-claims),
[callable functions](https://firebase.google.com/docs/functions/callable), and
[Cloud SQL IAM connectors](https://docs.cloud.google.com/sql/docs/postgres/connect-connectors).

## Dev release verified 2026-11-08

- Applied only the three additive staff tables and three indexes from the reviewed
  SQL diff. Imported one existing Google admin profile without modifying its Auth
  grants. No new cloud Auth users or demo business records were created.
- Registered the schema with `COMPATIBLE` and deployed the `staff-admin` connector.
  The schema registration required a reviewed write pause because native order
  constraints are stricter than SQL Connect's generated definitions. Writes to
  client, product, order, item, payment, refund and audit tables were blocked by
  temporary statement triggers before changing any native constraints. The five
  CHECK and six RESTRICT foreign-key definitions were captured beforehand,
  temporarily replaced with generated definitions, then restored exactly before
  removing the write-pause triggers. Original audit/identity protection triggers
  stayed enabled throughout. The restoration path also runs on deployment errors.
- Verified all five CHECK constraints, three original protection triggers and six
  RESTRICT foreign keys after registration. Future releases must repeat the
  reviewed maintenance procedure if schema changes affect the hardened database;
  never force the destructive generated migration or leave write guards installed.
- Deployed `registerStaffSignIn`, `setStaffRoles`, and `reconcileStaffRoles` from
  the `server` codebase to `northamerica-northeast1`. They use the dedicated
  `mtl-staff-functions` runtime identity, with Cloud SQL Client/Instance User and
  a custom Auth role containing only `firebaseauth.users.get` and
  `firebaseauth.users.update`. Database rights are SELECT/INSERT/UPDATE on the
  three staff tables plus schema usage.
- The minute reconciliation job is enabled and scheduled requests returned HTTP
  200, verifying runtime SQL connectivity. Build images have a 30-day cleanup
  policy in the regional `gcf-artifacts` repository. Runtime parameters are kept
  in the ignored project dotenv file; no credentials were committed.
- Live read-only smoke checks verified the imported profile, directory privacy,
  admin account/history queries, denial for unapproved claims, unauthenticated
  callable rejection, and the deployed `COMPATIBLE` setting. Google sign-in and
  role-write flows remain covered by the 58 passing local tests; no cloud role
  changes were made solely for verification.
