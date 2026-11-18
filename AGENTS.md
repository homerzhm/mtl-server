# MTL server

This directory maintains Firebase SQL Connect (`restaurant`), backed by Cloud SQL for PostgreSQL, and TypeScript Firebase Functions for trusted backend operations.

## Where to work

- Edit GraphQL schema sources under `dataconnect/schema/`. Add new tables as `@table` types.
- Use `dataconnect/dataconnect.yaml` for SQL Connect service and database settings, `firebase.json` for Firebase and emulator settings, and `.firebaserc` for project aliases.
- Keep generated emulator files, debug logs, and credentials out of source control.

## Merging into main

- Always squash the branch's changes when merging into `main`, so each merged
  change contributes exactly one commit to `main`.
- Use a squash merge for pull requests or `git merge --squash` followed by one
  commit for local merges. Do not preserve the branch's individual commits or
  create an additional merge commit on `main`.

## End-to-end releases

- Treat a request to deploy to dev or production as authorization to complete the
  full server release for that target, including routine fixes, validation, and a
  release commit. For a request to deploy if validation passes, fix recoverable
  blockers within the release scope and rerun the checks before deploying.
- Review committed changes since the last managed release and tracked and
  untracked work in this project. Include all deployable project changes unless
  the user specifies a narrower scope. Update the release manifest to cover every
  affected component, SQL migration, database contract, and runtime grant. Keep
  local-only files and credentials out of the release commit.
- Follow [the release runbook](docs/releases.md). Run the applicable local checks,
  review any target schema diff, and prepare a clean release commit. Apply reviewed
  additive SQL and verify its prerequisites before registering a schema that
  depends on those changes. Preserve the existing review requirement for destructive
  SQL and breaking connector changes.
- Deploy with `npm run deploy` for dev. For an explicit production request, first
  deploy and verify the exact release in dev, complete the runbook's dev acceptance,
  then promote the same commit with `npm run deploy -- --environment production`.
  Reuse a current dev acceptance for that exact commit when the runbook permits it.
- Verify all affected components and migrations on the requested target. Diagnose
  failures and resume recoverable release stages until verification passes. Report
  the target, commit, and verified components. If blocked, report which stages
  applied and what remains pending.

## Product conventions

- Each `Product` row represents one sellable menu item. Store its fixed selling price as integer CAD cents in `priceCents`.
- Use `isActive` for whether the item is offered on the menu and can be ordered. Sold-out status is managed outside `Product`.
- Products optionally link to one `CapacityGroup`; each ordered quantity consumes one place.
  Capacity uses that link, not a lechon Boolean. Preserve booked group snapshots.

## Schema changes and deployment

- Preserve existing rows and client operations. Prefer additive changes. When existing rows need a new required value, add the field as nullable, backfill it, then enforce the requirement.
- Keep `schemaValidation: COMPATIBLE`. Flag destructive SQL or breaking connector changes for review before applying them.
- Validate schema changes locally from this directory:

  ```sh
  firebase emulators:exec --only dataconnect --project demo-mtl "true"
  ```

- Treat a schema edit as local work unless the user requests deployment. Before deploying to `dev`, review the migration with `firebase dataconnect:sql:diff --project dev`. For a schema-only release, deploy only the schema:

  ```sh
  firebase deploy --only dataconnect:restaurant:schema --project dev
  ```

- Pass an explicit `--project` for cloud commands. The `dev` alias points to `mtl-service-e3e0c`. Production setup and deployments require an explicit request.

## Staff admin connector

- Product operations live under `dataconnect/staff-admin/`. List and get require
  a signed-in user. Create and update require Google sign-in and Boolean
  `staff:true` and `admin:true` claims.
- Product prices are nonnegative signed 32-bit CAD cents. Keep optional Chinese
  names; preserve descriptions and creation timestamps during editor updates.
- Updates must atomically match and increment `revision`; do not use upsert for
  existing-product edits. The dependent post-write lookups are intentional.
- Run `firebase emulators:exec --only dataconnect --project demo-mtl "node --test tests/products.test.mjs tests/clients.test.mjs tests/orders.test.mjs tests/client-history.test.mjs"`
  with current Firebase CLI and a native Node runtime. The tests never target cloud.
- Follow the staged revision migration and Swift SDK generation steps in README.md.
  Generated SDK files under `dataconnect/generated/` are ignored; iOS tracks its copy.

## Client contacts

- Keep a stable UUID identity and database-unique `phoneNumber`; name and email
  are nullable. Normalize 10-digit Canadian/default NANP input to `+1` plus the
  digits in add, edit, and phone lookup. Store international form only.
- Client operations require Google sign-in and Boolean `staff:true` OR
  `admin:true`. Keep these permissions separate from product permissions.
- Client edits atomically match and increment `revision`, preserve `createdAt`,
  and never upsert. Optional fields are a full form replacement; null clears.

## Firebase Functions

- Functions live in `functions/`, use native Node 22 and TypeScript, and share the
  `server` deployment codebase. Organize each topic under `functions/src/<topic>/`.
  Staff currently owns `staff/handlers.ts`, `service.ts`, `database.ts`, and `setup.ts`.
- Keep `functions/src/index.ts` limited to explicit, flat trigger exports. Preserve
  existing exported names because changing names or nesting exports changes the
  deployed endpoints. New topics add their own exports here.
- Keep trigger definitions, request/response handling and dependency wiring in
  topic handlers; put business rules in injectable services. Trusted CLI setup
  scripts are separate entrypoints and must never be exported as cloud triggers.
- Put only reusable infrastructure in `functions/src/shared/`. Reuse the lazy
  `getAdminApp()` helper; do not initialize the Admin SDK or connect to services
  at module import time. Topic-specific permissions, database access and parameters
  stay within that topic until another topic actually needs shared behavior.
- Configure region, identity, timeouts, instance/concurrency limits and schedules
  per topic or trigger. Do not use `setGlobalOptions` for topic-specific settings.
  Bound database pools and instance counts together against the Cloud SQL connection
  budget; each function scales separately even within one codebase. Dev has 25
  connections (three reserved): all seven current triggers use maxInstances 1,
  concurrency 2 and pool max 2, totaling at most fourteen pooled connections. Staff's role
  control lock is specific to role changes, not a lock for unrelated topics.
- Authorize callable requests before initializing external dependencies. Enforce
  permissions on the server, validate inputs, preserve known `HttpsError`s, and
  return sanitized errors for unexpected failures. Serialize timestamps explicitly.
- Use topic-prefixed configuration parameters (currently `STAFF_*`) and dedicated
  runtime identities with least-privilege IAM/database grants. Keep dotenv files,
  credentials, `functions/lib/`, and `functions/node_modules/` out of source control.
- Put tests in `functions/test/<topic>/unit.test.mjs` and `emulator.test.mjs`.
  Run `npm --prefix functions test` and `npm --prefix functions run test:emulators`.
  The latter uses disposable native PostgreSQL plus Auth/Functions/SQL Connect
  emulators for `demo-mtl`; tests must never use cloud services. Extend its isolated
  local configuration when adding topic parameters or emulator dependencies.
- Builds clean obsolete compiled modules before compiling. Keep the package lock
  committed and use `npm --prefix functions ci` for reproducible installs.
- Functions deployment requires an explicit user request. Pass `--project`; deploy
  an individual function when appropriate, or `--only functions:server` for the
  complete codebase. Review the full export inventory before deploying a codebase
  because omitted existing exports can cause deletion prompts. Production requires
  an explicit request. Document each topic's setup, IAM, API, tests and rollout.

## Staff role management

- Follow `docs/staff-management.md` for the callable contract, trusted setup/import,
  configuration, recovery, deployment and later iOS integration.
- Staff accounts use Firebase UID identity and independent Boolean Staff/Admin
  flags. Google registration uses trusted Auth profile data and creates pending
  accounts; it never grants roles from client data or token claims.
- Existing business operations continue using Firebase claims. Role management
  additionally requires the actor's current stored Admin flag and current Auth
  admin access. Never expose direct client role/audit/control writes.
- Preserve role revisions, history, self-demotion/last-admin protection, and the
  singleton lock across Auth synchronization and database finalization. Persist
  requests before writing claims; retain failed requests for idempotent retries
  and block overlapping changes. Preserve unrelated custom claims.
- Claim synchronization and token refresh are distinct. Do not promise immediate
  revocation of existing ID tokens. Import existing grants with the trusted setup
  command before enabling registration; bootstrap requires an explicit UID.

## Client directory integration

- The native directory uses `ClientDirectoryEntry` and the ListClientDirectory,
  GetClientSummary, and ListClientHistory reads. Keep stable-ID history separate
  from phone snapshot lookups. Count cancellations; exclude them only from latest
  order creation dates. Net spent is successful receipts minus successful refunds.
- Aggregate receipts and refunds separately to avoid join multiplication. Keep
  all new reads under the existing Google staff-or-admin policy and page at 100.
- Keep aggregate CAD cents and order counts as Int64. Exclude voided ledger
  entries. Return zero aggregates and a null latest date for clients without orders.
- Directory reads use phone substring filtering and UUID ascending pagination;
  history uses creation date then UUID descending. Test directory pagination with
  more than 100 clients, independently of fixtures from other test files.
- Match existing client phone search validation: accept only digits and `+`,
  allow empty input to list all contacts, and do not add a country code to fragments.
- `ClientDirectoryEntry` is query-backed and changes no physical table. Deploy
  new view types through reviewed GraphQL schema maintenance before deploying
  their connector additions. Preserve all native constraints and audit triggers;
  the generated hardened-order SQL diff must not be applied directly. Run
  `tests/client-history.test.mjs` with the other connector tests.

## Native order booking integration

- Follow `docs/live-order-booking.md`. `createStaffOrder` is the sole atomic native
  multi-item creation path, under the existing Google staff-or-admin policy.
- Keep order/item UUIDs stable across uncertain retries. Match actor and canonical
  payload hash before returning an existing result. Never chain one-item writes.
- Preserve server catalog snapshots and revisions, exact CAD cents, automatic
  audit and all-or-nothing item/allocation/request persistence.
- Shared daily blocks live in singleton `BookingSettings`; timezone stays America/Toronto.
  Bootstrap 11:00/13:00/15:30/18:00 only; do not seed capacity groups or limits.
  Admins create groups with explicit independent positive Int32 limits through
  `manageBookingConfiguration`; one product quantity uses one place.
  All blocks and pickup must be future; pickup is a 15-minute time at/after the
  latest allocated block across all groups.
- `manageBookingConfiguration` requires Google Staff AND Admin. Configuration
  changes apply immediately with revision checks. Reject removal of occupied
  upcoming blocks and limits below upcoming occupancy; archive only unlinked groups.
- Serialize capacity writers with the common `booking-capacity` advisory lock,
  acquired before row locks. SQL statement triggers use the same lock. Cancellation
  releases occupancy, completion retains it, and reopening checks current blocks
  and limits using saved group allocations, including archived groups.
- Keep SQL guards blocking legacy item/schedule edits of managed orders, legacy
  unallocated grouped creation and unmanaged grouped reopening. Allocations are
  immutable history; deferred checks require exact item/allocation group totals.
- Summary types are query-backed reads, not physical SQL views. Availability is
  the paginated `getBookingAvailability` callable, including empty blocks and
  configuration revisions. Number and phone searches use separate exact operations.
  Page every read at 100 with stable ordering. Keep group and ledger sums separate.
- Grant only EXECUTE on the pinned-search-path source-lock helper; do not grant
  the Orders runtime product/client UPDATE just to take row locks. Test its actual
  restricted database permissions.
- `ORDERS_*` configuration and a dedicated least-privilege runtime identity are
  separate from Staff roles. Keep migration/operator identities out of triggers.
- Booking has no activation gate, enable flag, rollout table or setup script.
  Preserve capacity enforcement and legacy-write guards without flag-dependent
  conditions.
  No cloud deployment is implied by edits.

## Native order actions

- `updateStaffOrder` atomically records cash, marks Paid or completes pickup using
  stable request UUIDs, actor/payload ownership, parent revision locks and audit.
- Cash is Confirmed-only; exact positive Int32 cents may exceed the balance.
  Paid requires no outstanding saved subtotal less discount, finalizes that amount
  without creating a receipt, and locks payments. Pickup requires Paid.
- Apply additive OrderActionRequest schema and `migrations/order-actions.sql`
  before the new callable. Managed native orders reject legacy payment/status
  bypasses; retain legacy rows' connector behavior and existing admin corrections.
- ORDERS runtime now needs SELECT on payment/refund/action requests, INSERT on
  payment/action requests and column UPDATE only on customer_order revision,
  status, final_total_cents, completed_at and updated_at. No product/client UPDATE.
- iOS journals unresolved requests per account/order for explicit retries across
  restarts. Never auto-replay a payment or replace an uncertain request identity.
- No cloud deployment or live payment/status writes are implied by edits.

## Creation cash deposits

- `createStaffOrder` optionally accepts `depositReceivedCents`, bounded to the
  subtotal, and atomically inserts a SUCCEEDED CASH receipt plus PAYMENT_RECEIVED
  audit with server actor/time. Zero/absence inserts no receipt. Keep CONFIRMED
  until explicit Paid, even for a full deposit. Increment the parent revision
  before inserting the receipt, using the existing ledger safeguards/grants.
- Retain `depositRequiredCents` as requested-only for old callers and historical
  rows. Reject both amounts positive. Omit absent received amounts from canonical
  normalization so stored legacy hashes continue to reconcile unchanged.
- All creation rows, receipt, audit and request commit together. Retries match
  actor and exact canonical payload before current-time/catalog checks; never
  duplicate a payment or convert historical requested deposits.
- Release the compatible callable before the updated app; deployment is explicit.


## Native payment corrections

- `updateStaffOrder` PAYMENT_EDIT accepts paymentId and exact Int32 amountCents
  including zero, with the same actor/payload request ownership and loaded revision
  as existing actions. Canonical hashes for PAYMENT/PAID/PICKUP stay unchanged.
- Staff OR Admin correct successful CASH receipts on CONFIRMED/PAID; only Admin
  corrects COMPLETED/CANCELLED. Lock the parent before the receipt, increment its
  revision before ledger mutation and commit receipt/status/audit/request together.
- Cap a correction at the receipt plus positive saved balance, using cancellation
  total for cancelled orders and successful receipts minus successful refunds.
  Zero marks VOIDED, preserving positive amount, identity/timestamps and refund links.
  Refunds stay unchanged even below their total or after receipt removal: negative
  net paid is permitted. Do not apply the older void operation's refund prohibition
  to PAYMENT_EDIT; preserve that older operation's restrictions.
- Paid left owing returns to Confirmed without changing final total; closed statuses
  remain unchanged. Append PAYMENT_CORRECTED/PAYMENT_REMOVED structured before/after
  audits with actor UID. Never replace the original receipt recorder/time.
- Apply migrations/payment-edits.sql after order-actions.sql and grant only payment
  UPDATE(amount_cents,status) in addition to existing action grants. Deploy the
  compatible callable before the iOS release; no deployment is implied by edits.

## Native order edits and cancellation

- `updateStaffOrder` EDIT replaces active-order items/client/pickup/allocations/notes
  atomically. Keep saved IDs/prices/group snapshots; new lines require current
  active catalog revisions. Preserve payments/discount/deposit fields. Reviewed
  subtotal less discount updates an existing final total; Paid owing becomes Confirmed.
- Unchanged schedules may be past. Changed schedules must be future. Exclude own
  occupancy; unchanged/decreased places can retain lower historical limits and
  archived group snapshots, but new/increased archived placements are rejected.
- CANCEL is Confirmed/Paid-only for Google Staff OR Admin. Explicit refund means
  cash already physically returned. Derive retained cancellation charge from net
  paid; split successful cash refunds oldest receipt then ID, subtracting previous
  successful refunds. Zero net cancels at zero; negative net requires correction.
  Reason is optional, trimmed, max 1,000 UTF-16 code units. Preserve original totals,
  items and allocation history; status releases occupancy. No provider transfer.
- Standalone refunds remain admin-only. Cancel/refunds/revision/audit/request commit
  together. Existing action hashes remain unchanged and matching retries reconcile
  before current-time/revision checks. Use capacity lock before parent/receipt locks.
- NativeOrderEditContext is an additive private @table with no connector operation.
  Review/deploy that schema through compatible maintenance before native SQL.
- Apply order-edits.sql after payment-edits.sql and last after older booking
  migrations; grant only documented routine/cancellation/refund access. Never grant
  context-table writes or connector EXECUTE on apply_native_order_edit. Preserve
  these guards/private table in future schema maintenance. Deploy compatible
  updateStaffOrder before the app; no deployment/live financial writes implied.
