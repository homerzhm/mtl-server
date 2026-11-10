# MTL server

Firebase SQL Connect service `restaurant` in `northamerica-northeast1`; dev project
`mtl-service-e3e0c`. Keep `schemaValidation: COMPATIBLE`.

## Staff admin catalog

The `staff-admin` connector offers `ListProducts`, `GetProduct`, `CreateProduct`,
and `UpdateProduct`. List and get require a signed-in user with any sign-in
provider, without staff or admin claims. Create and update require Google sign-in
and Boolean `staff:true` plus `admin:true` custom claims. Claims are granted only from a trusted
Admin SDK environment; the iOS app cannot grant them.

Products use UUID identity and integer CAD cents (0 through 2147483647). Names
must be nonblank and trimmed; Chinese names are optional, trimmed, and nonblank
when present. Duplicate names and zero prices are allowed. `isActive` controls
availability for new orders. There is no delete operation or order usage count.
Updates preserve `description` and `createdAt` and atomically match the expected
revision before incrementing it. An unmatched revision produces PRODUCT_CONFLICT.
Validation failures produce PRODUCT_VALIDATION and roll back the transaction.
The dependent response lookup is intentional: it runs after the database write.

## Client contacts

The `Client` table has a permanent UUID, required unique `phoneNumber`, optional
`name` and `email`, and server-owned `revision` and `createdAt`. Phone corrections
preserve identity and creation time. Email addresses are not unique.

All client operations require Google sign-in and a Boolean `staff:true` **or**
`admin:true` claim. Product permissions are unchanged.

- `GetClient(id)` returns a client or null.
- `GetClientByPhoneNumber(phoneNumber)` returns a `clients` array with zero or one
  result, because SQL Connect singular lookups use the primary UUID key.
- `SearchClientsByPhoneNumber(phoneNumber, offset = 0)` returns clients whose
  stored phone number contains the literal input anywhere (for example, `416`).
  Results contain the same fields as `ListClients`, with 100 rows per page in
  creation-time, UUID order. Continue with offsets 100, 200, etc. until a page
  has fewer than 100 rows. Input is used as-is without adding a country code;
  submit digits or canonical international form. Characters other than digits
  and `+` are rejected. Empty input matches all clients.
- `ListClients(offset = 0)` returns 100 rows per page in creation-time, UUID order.
  Continue with offsets 100, 200, etc. until a page has fewer than 100 rows.
- `CreateClient(id, phoneNumber, name?, email?)` inserts a client. Generate a UUID
  in the caller. Duplicate IDs or phone numbers fail; existing contacts are never
  overwritten. Omitted optional fields are null.
- `UpdateClient(id, phoneNumber, name?, email?, expectedRevision)` saves a complete
  contact form. Pass both optional fields; null (or omission) clears them. The
  expected revision must match; a missing or stale row produces `CLIENT_CONFLICT`.
  Successful edits increment the revision atomically. Read the nested post-write
  `query.client` response for the saved row.

Canada is the default: exactly 10 digits such as `4165551234` are normalized on
add, edit, and phone lookup to `+14165551234`. International input must already
contain `+` followed by 2–15 digits, starting with a nonzero country code.
Spaces, punctuation, extensions, and other local formats are rejected on writes
with `CLIENT_VALIDATION`; callers should submit digits or canonical international
format. Validation checks format, not whether a number is assigned or reachable.
The database unique constraint enforces uniqueness even for concurrent requests.
Failed validation and duplicate edits roll back the entire transaction.

The new table is additive and requires no existing-row backfill. Before a
requested dev release, review
`firebase dataconnect:sql:diff --project dev`, apply the reviewed additive SQL
migration, and deploy both schema and connector. Generate the Swift SDK as below
when integrating the operations into iOS.

## Staff profiles and roles (deployed to dev)

The staff account schema, callable backend, setup command, verification, deployment
procedure, and iOS integration contract are documented in
[docs/staff-management.md](docs/staff-management.md). The schema, connector and
Functions are deployed to dev; see the verified release record in that document.

## Local verification

Use an ARM-compatible Node installation and current Firebase CLI (tested with
firebase-tools 15.35.0 / SQL Connect emulator 3.4.25). Then run:

```sh
firebase emulators:exec --only dataconnect --project demo-mtl "node --test tests/products.test.mjs tests/clients.test.mjs tests/orders.test.mjs"
```

Tests use unsigned Firebase tokens accepted only by the local emulator and never
send requests to the cloud. They cover authorization for every operation, exact
cents, optional fields, soft hiding, duplicate names, zero price, validation
rollback, concurrent updates, missing rows, and description preservation.
Client tests cover staff/admin access, optional fields, normalized uniqueness,
phone corrections, transaction rollback, revision conflicts, partial phone
search, and pagination.

## Swift SDK generation

Connector output is local and ignored. Generate then copy to the iOS checkout:

```sh
firebase dataconnect:sdk:generate --project dev
```

Copy `dataconnect/generated/StaffAdmin/StaffAdmin` into
`<iphone checkout>/Generated/StaffAdmin/StaffAdmin`, then run
`python3 Scripts/prepare-staff-admin-sdk.py` in the iOS checkout. This makes the
connector initializer public for injection and removes its global convenience
instance. Commit generated Swift sources with the matching server operations.

## Revision migration (existing databases)

1. Prepare a schema-only intermediate version with `chineseName: String` and
   `revision: Int` (nullable, without the final default). Review
   `firebase dataconnect:sql:diff --project dev` before running `firebase dataconnect:sql:migrate --project dev` and then
   deploying with `firebase deploy --only dataconnect:restaurant:schema --project dev`.
2. Run the trusted ad hoc mutation in `migrations/backfill-product-revision.gql`
   with `firebase dataconnect:execute migrations/backfill-product-revision.gql BackfillProductRevision --project dev`.
3. Review the final SQL diff, run `firebase dataconnect:sql:migrate --project dev`,
   then deploy the checked-in schema containing
   `revision: Int! @default(value: 0)` and the connector:
   `firebase deploy --only dataconnect:restaurant --project dev`.

Do not expose the backfill through a client connector. Preserve existing rows.
Dev deployment is separate from production deployment; always pass a project.

The catalog query returns 100 rows per page; iOS exhausts pages in creation-time,
UUID order so lists and counts include every product. To deploy, the account used
by Firebase's compiler subprocess must match the account selected for the CLI;
Firebase CLI 15.35.0 may ignore `--account` in that subprocess. Use a project-scoped
account selection when this occurs, rather than changing global credentials.

### Dev deployment verified 2026-11-06

Added nullable columns, deployed the intermediate schema, ran the null-only
revision backfill (0 rows required changes), then enforced revision NOT NULL and
default 0. Deployed the final schema and `staff-admin` connector to dev. No demo
products were inserted into the cloud database.

### Client contacts dev deployment verified 2026-11-07

Reviewed and applied the additive migration creating `client` and its unique
phone-number index. Deployed the schema and `staff-admin` connector to dev
(`mtl-service-e3e0c`); Firebase confirmed database compatibility and successful
connector deployment. All 26 local client and product emulator tests passed.
No client records were inserted into the cloud database during verification.

## Orders (deployed to dev)

The order model is in `dataconnect/schema/orders.gql`; operations are in
`dataconnect/staff-admin/orders-*.gql`. See `docs/order-design.md` for the workflow.
Existing product/client operations and permissions are unchanged.

Orders use UUIDs internally and permanent, unique six-character pickup numbers.
PostgreSQL generates the number from random UUID symbols, replacing ambiguous
0/1 with G/H. Lookups accept lowercase. A rare number collision rolls back the
entire create; retry with the **same order and first-item UUIDs**. After an
uncertain network result, first fetch by order UUID to determine whether creation
committed. The code is a staff lookup reference, not API authorization.

All order reads and regular writes require Google sign-in with Boolean
`staff:true` **or** `admin:true`. Admin-only operations require `admin:true`;
they do not require both claims. Staff can edit confirmed orders, complete them,
assign clients to completed orders, and receive cash after completion. Financial
edits after completion and changes to cancelled orders require admin access.
Money owing never blocks completion. No order delete or audit-write operation
is exposed.

Order statuses are `CONFIRMED`, `PAID`,
`COMPLETED`, and `CANCELLED`. `PAID` is a manual staff confirmation through
`MarkOrderPaid(id, expectedRevision)`, intended for the UI's button. It does not
create a payment, require a finalized total, or validate the ledger balance.
Recording receipts, refunds, or price edits never automatically changes this
status. The ledger remains the source for numeric balances; show it separately.
Paid orders remain editable like confirmed orders. Admins can undo the manual
mark using `ReopenOrder`; the original action stays in audit history.

| Operation | Contract |
| --- | --- |
| `CreateOrder` | Caller supplies stable order/item UUIDs and a first product/quantity. Product must be active. Name and catalog price are copied on the server; optional unit-price override. Optional client, phone, schedule, notes and deposit requirement. |
| `AssignOrderClient` | Sets or clears only the client link. Never replaces the contact snapshot or prices. |
| `UpdateOrderContact` | Full replacement of phone and internal notes; omission/null clears them. Does not modify the client link. |
| `UpdateOrderPricing` | Full replacement of discount, requested deposit and manual final total; omitted/null final total clears finalization. |
| `UpdateOrderSchedule` | Sets or clears scheduled pickup. |
| `AddOrderItem`, `UpdateOrderItem`, `RemoveOrderItem` | Maintain exact subtotal/item count in the same revision-checked transaction. Keep at least one item. Updates preserve catalog/name snapshots; notes are replaced. |
| `MarkOrderPaid` | Staff/admin manually mark a confirmed order PAID; audited, revision-checked, no automatic receipt or balance check. |
| `CompleteOrder` | Confirmed or paid to completed, regardless of payment/final-total state. |
| `CancelOrder` | Requires explicit nonnegative cancellation charge; staff can cancel confirmed/paid orders, admins can also cancel completed orders. No automatic refund. |
| `UpdateCancellationSettlement`, `ReopenOrder` | Admin only. Reopening clears lifecycle timestamps/cancellation charge; history preserves prior values. |
| `RecordCashPayment` | Staff/admin receipt on any order status; stable caller-generated payment UUID. |
| `RefundCashPayment` | Admin partial/full refund, stable refund UUID; cannot exceed the original receipt less active refunds. |
| `VoidCashPayment`, `VoidCashRefund` | Admin corrections mark records VOIDED, preserving amounts/history. A receipt with active refunds cannot be voided. Record a corrected receipt/refund separately. |

Except creation, every mutation takes `id` (order UUID) and `expectedRevision`.
Read the saved order at `data.result.order`. Each successful action increments
revision exactly once and appends one automatic audit event, including actor UID,
server time, action and relevant before/after values. Creation starts at revision
0. Audit timestamps in JSON are strings. There is no reason field or separate
frontend audit request. Failed transactions create no audit event. A stale or
missing order produces `ORDER_CONFLICT`; a forbidden status/action produces
`ORDER_FORBIDDEN`; validation failures roll back. Native PostgreSQL constraint
errors are also possible when the integrity migration is installed.

Phone numbers follow the client normalization rules and are optional/nonunique
on orders. Initial client selection copies its phone unless an explicit phone is
provided; later client/profile edits never silently rewrite an order contact.

`GetOrder` returns the order plus aggregate `financials`. Before manual checkout,
the balance uses subtotal minus discount and is labelled `isEstimate:true`.
After checkout it uses `finalTotalCents`; for cancellation it uses
`cancellationTotalCents`. Item edits preserve an existing manual total. Payments
minus refunds are derived from the ledger, including every page of records.
Negative balance means overpayment. No tax is automatically calculated or
inferred. Amount fields are signed 32-bit nonnegative CAD cents; aggregate
financial fields are `Int64`. Percentage-discount entry and external payments
are deferred. External references are reserved for a future trusted integration;
the staff connector only records cash.

`GetOrderByNumber` returns zero/one orders; `GetOrdersByPhoneNumber` may return
many. `ListOrders`, phone results, `ListOrderItems`, `ListOrderPayments`,
`ListOrderRefunds`, and `ListOrderAuditEvents` page at 100 with offsets
0, 100, etc. Audit events sort by revision; other lists include UUID tie-breakers.
For live lists, refetch on concurrent changes because offset pagination is not a
cross-request snapshot. SQL Connect query roots also are not a guaranteed shared
snapshot; reload `GetOrder` after writes rather than using it for write validation.

On timeout, reuse the original payment/refund UUID. A duplicate ID or stale
revision returns an error, never another receipt/refund. Inspect the ledger to
resolve an uncertain outcome before issuing a new UUID. All financial changes
serialize through the parent order revision, including refunds.

### PostgreSQL integrity migration

`migrations/order-integrity.sql` adds native CHECK constraints, immutable audit
triggers, immutable order identity, and RESTRICT foreign-key deletion rules.
SQL Connect cannot declare these protections in the GraphQL schema. The file is
repeatable and has been tested against local PostgreSQL; it is **not applied by
Firebase deploy**. The connector already enforces business invariants and offers
no audit update/delete operations, but native protections require this file.

For a new empty database: review `firebase dataconnect:sql:diff --project dev`,
apply the additive generated schema migration, deploy the schema/connector, then
execute this file using a trusted PostgreSQL connection and verify protections.
Keep `schemaValidation: COMPATIBLE`. No existing-row backfill is needed for the
new tables. Generate/copy the Swift SDK when integrating the iOS client using the
existing SDK instructions above.

Deployment caveat verified against dev: even COMPATIBLE validation rejects the
extra CHECK constraints and RESTRICT delete definitions. Once hardening is
installed, the SQL diff proposes destructive removal of these protections.
**Do not run `dataconnect:sql:migrate --force` against a hardened database.**
For connector-only updates, use `firebase deploy --only
dataconnect:restaurant:staff-admin --project dev` to avoid a schema deployment.
Future schema releases require a reviewed maintenance procedure that preserves
history and restores/verifies native protections after deployment; the initial
empty-table procedure must not be reused on populated order tables. Audit
immutability triggers must remain enabled throughout.

For the PAID update, no column/schema deployment is needed because status
is already text. After a deployment request, apply `migrations/order-paid-status.sql`
with a trusted PostgreSQL connection **before** the connector-only deployment.
It atomically broadens the existing order CHECK and preserves all other native
protections and existing rows. Reapplying the initial integrity file alone does
not update an existing CHECK. This follow-up migration is repeatable and tested
against the old three-status constraint.

To verify native protections locally, set `MTL_TEST_PG_MODULE` to the absolute
path of the `pg` module in a local Firebase CLI installation, then run:

```sh
firebase emulators:exec --only dataconnect --project demo-mtl "node --test tests/order-integrity.test.mjs"
```

That suite applies the migration twice to test repeatability, checks native
constraints and audit immutability, and reruns the order behavior suite with the
protections enabled. Both SQL and HTTP targets are fixed to localhost/demo-mtl.
Without `MTL_TEST_PG_MODULE`, that optional suite reports a skipped test.
Run it alone, or pass `--test-concurrency=1` when combining it with other test
files: the emulator's PGlite TCP adapter cannot safely overlap direct SQL sessions
with connector tests in separate workers.

Local verification on 2026-11-07: all 43 product/client/order and native SQL
checks passed with serial test-file execution. The native suite also verified
that the integrity migration can be applied twice.

### Orders dev deployment verified 2026-11-07

Applied the reviewed additive migration for five new tables. Canonicalized the
pickup-number SQL default to PostgreSQL's reported expression, eliminating
repeated default migration drift. Deployed the schema and `staff-admin` connector
to `mtl-service-e3e0c`, keeping COMPATIBLE validation.

The initial hardening-before-deployment attempt exposed the validator caveat
above. With zero orders confirmed under table locks, temporarily aligned the
CHECK/FK definitions with the generated schema, retained audit/identity triggers,
deployed, then immediately reapplied hardening. Final metadata verification found
five validated CHECK constraints, three enabled triggers, six RESTRICT foreign
keys, and zero orders. A read-only cloud GraphQL smoke check of orders, audit
events and both financial summaries passed. No business records were inserted.
All 40 regular product/client/order emulator tests passed after the default fix.

### Manual PAID status dev deployment verified 2026-11-07

Applied the reviewed `migrations/order-paid-status.sql` to broaden the existing
order CHECK, then deployed only `dataconnect:restaurant:staff-admin` to dev.
Verified that the deployed connector includes `MarkOrderPaid` and the native
CHECK accepts PAID, with all five validated checks, three enabled triggers and
six RESTRICT foreign keys retained. Read-only cloud smoke queries passed; zero
orders existed and no business records were inserted during verification.
All 47 local product/client/order and native migration tests passed before release.

## Native Client directory and history

`ClientDirectoryEntry` is a query-backed summary view. It joins each contact with
its linked order count (including cancellations), latest non-cancelled order
creation date, and successful receipts minus successful refunds. Separate ledger
aggregations avoid multiplying payments and refunds. Retained cancellation
payments remain in net spent. History follows `Order.clientId` only; edits to
client phones never change ownership or order contact snapshots.

- `ListClientDirectory(phoneNumber = "", offset = 0)` returns contact fields,
  revision, order count, last order date, and net paid cents. Phone matching is a
  literal substring; only digits and `+` are accepted, and empty input matches all
  clients, consistent with `SearchClientsByPhoneNumber`. Pages contain at most
  100 rows, ordered by UUID; iOS consumes
  all pages and sorts by last order descending, then canonical phone and UUID.
- `GetClientSummary(id)` returns zero or one directory summary.
- `ListClientHistory(id, offset = 0)` returns up to 100 linked orders, newest
  creation date then UUID descending, with order number, item count, actual
  status, and total/estimate fields. This does not expose any new mutation.

All three reads use the existing Google staff-or-admin authorization. Monetary
aggregates use Int64 CAD cents. No table or column migration is required for this
query-backed view. The new GraphQL view type must be registered before deploying
its connector operations. Preserve all native order protections through the
reviewed schema-maintenance procedure below; never apply the generated destructive
native-constraint migration directly.

Run local coverage with:

```sh
firebase emulators:exec --only dataconnect --project demo-mtl "node --test tests/products.test.mjs tests/clients.test.mjs tests/orders.test.mjs tests/client-history.test.mjs"
```

### Native Clients dev deployment verified 2026-11-09

All 48 product/client/order/history emulator tests passed. The SQL diff proposed
only the known removal of native CHECK/RESTRICT protections, so no SQL migration
was applied. A connector-only attempt before registering the new view failed
validation and left the existing connector intact.

Registered only the additive `clients.gql` source after verifying the other three
deployed schema sources were byte-for-byte unchanged. Used the established
maintenance procedure: snapshot all 11 native constraint definitions; install
transactional write-pause triggers on client/product/order/item/payment/refund/
audit tables; temporarily match SQL Connect's constraint definitions; register
GraphQL sources with COMPATIBLE validation and no automatic migration; restore
the exact original constraints and remove the temporary guards transactionally
in a finally block. Immutable audit/identity triggers remained enabled throughout.
Then deployed only `dataconnect:restaurant:staff-admin` to dev.

Verified five validated CHECK constraints, six RESTRICT foreign keys, three enabled
immutable-data triggers, and preserved PAID status support. The database had zero
orders before and after registration; no fixtures were written to cloud. The
signed native app successfully read the empty live directory with its approved
Firebase session. In future releases, an already-registered view's connector
changes can deploy alone; new schema types need this reviewed registration step.

## Native live Orders and roast booking

The additive native integration deployed to dev is documented in
[Live order booking](docs/live-order-booking.md): atomic multi-item creation,
idempotent retries, real capacity enforcement, read summaries and a gated rollout.
It adds the `createStaffOrder` callable without changing existing flat Staff
exports. Apply the reviewed additive schema and booking integrity migration before
its trusted fresh-environment activation. No cloud deployment is implied by code.


Dev deployment was verified on 2026-11-09 with 77 passing local tests. Schema,
connector and callable are deployed; native integrity protections are preserved.
The four server Functions share an eight-connection worst-case pool budget.
Booking activation remains disabled; see the detailed release record and separate
activation procedure in [Live order booking](docs/live-order-booking.md).
