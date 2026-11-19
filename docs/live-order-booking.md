# Native order creation and configurable capacity groups

The capacity-group refactor was deployed to dev (`mtl-service-e3e0c`) on 2026-11-12.
Earlier release records below describe the previous lechon-specific implementation.
The app is unreleased; no old-app compatibility layer is included. Existing dev
bookings were preserved during release as documented below.

## Storage and daily rules

`BookingSettings` has exactly one row, ID `default`, with an integer `blockMinutes`
array, revision, updatedAt and updatedBy. Blocks repeat every day in America/Toronto.
There are no date rows, scheduled versions or holiday overrides. Values are unique
15-minute offsets from midnight, 0–1439, with a nonempty schedule of at most 96 blocks.

`CapacityGroup` has stable UUID/code, editable name, positive Int32 capacityPerBlock,
archived, revision, createdAt, updatedAt and updatedBy. Groups have independent pools;
one block can hold 18 lechon AND 4 belly. Every product optionally references one
capacityGroupId. Each ordered quantity consumes one place, regardless of size.
Null means no capacity requirement. Assignment changes increment product revision.
CreateProduct and UpdateProduct accept capacityGroupId instead of isLechon; optional
fields are full replacements, so null/omission clears the link. Existing product
read/write authorization, cents, descriptions and timestamp preservation remain.

`OrderItem` snapshots capacityGroupId and capacityGroupNameSnapshot. Reassignment
or renaming never moves an existing booking or rewrites its display snapshot.
`OrderCapacityAllocation` stores orderId, pickupDay, groupId, blockMinute and quantity,
unique per order/group/block. Quantities and group capacities are positive Int32;
aggregate counts remain Int64. Allocations are immutable history.

## Creation contract

Use [historical order import](historical-order-import.md) for completed pickups from older records.

`createStaffOrder` remains a flat callable in northamerica-northeast1, requiring
Google sign-in and Boolean Staff OR Admin. Authorize before constructing dependencies.
Fields below are required except `depositReceivedCents`; optional form values use explicit null:

```typescript
{
  id: string; // stable request/order UUID
  items: Array<{id: string; productId: string; expectedRevision: number; quantity: number}>;
  clientId: string | null;
  contactPhoneNumber: string | null;
  scheduledFor: string; // UTC ISO, zero seconds, quarter-hour Toronto time
  expectedSettingsRevision: number;
  expectedGroups: Array<{id: string; expectedRevision: number}>;
  allocations: Array<{groupId: string; blockMinute: number; quantity: number}>;
  depositRequiredCents: number; // requested only, retained for legacy callers
  depositReceivedCents?: number; // cash already received; new callers send this and requested = 0
  notes: string | null;
}
```

At most 100 distinct products, quantity 1–99 each. The expected group list must
exactly match the server-resolved groups. Allocations may split each group across
blocks on the pickup day; totals must exactly equal that group's ordered quantity.
Ungrouped items need no allocations. All blocks must exist in saved settings.
Pickup must be future, on a 15-minute boundary, at/after the latest allocated block
across all groups. Every block must still be future at commit. There is no advance
horizon or staff override. Contact normalization, Int32 CAD cents, deposit bounds,
CONFIRMED creation, product/client source locking and collision retries remain.

A positive `depositReceivedCents` creates one SUCCEEDED CASH payment using server
time and a PAYMENT_RECEIVED audit event with the actor UID. It cannot exceed the
subtotal; blank/zero UI values send zero and create no receipt. Both deposit fields
cannot be positive. The order stays CONFIRMED, with no finalized total, even when
fully covered. Increment the parent revision before inserting the receipt. Existing
requested deposits and older clients create no payment; omitted new fields remain
omitted during canonicalization to preserve stored legacy payload hashes.

Response: `{id}`. Items, snapshots, allocations, optional receipt, request and audit save atomically.
Canonical hashing sorts item IDs, expected group IDs, and group/block allocations.
UUIDs are lowercase. Keep request/item UUIDs and the exact payload across uncertain
retries. Matching committed requests reconcile before checking current time,
catalog or configuration; changed actor/payload returns REQUEST_CONFLICT.

Known failures include CATALOG_CHANGED, BOOKING_CONFIGURATION_CHANGED,
GROUP_CAPACITY, PICKUP_EXPIRED, CLIENT_UNAVAILABLE and REQUEST_CONFLICT.
Unexpected errors are logged and sanitized as uncertain outcomes. Never automatically
replace an uncertain request identity or auto-replay cash payments.

## Configuration and availability APIs

`manageBookingConfiguration` requires Google Staff AND Admin and accepts one of:

```typescript
{action: 'UPDATE_SETTINGS', expectedRevision: number, blockMinutes: number[]}
{action: 'CREATE_GROUP', id: string, code: string, name: string, capacityPerBlock: number}
{action: 'UPDATE_GROUP', id: string, expectedRevision: number,
 name: string, capacityPerBlock: number, archived: boolean}
```

Codes are immutable uppercase identifiers (letters, digits, underscores; start
with a letter, max 64). Names are nonblank, trimmed, max 200 characters. New IDs
are caller-generated UUIDs. Responses contain the saved settings/group with its
revision and ISO timestamps. Creation is not a booking-idempotency API: after an
uncertain configuration save, reload before retrying. Duplicate IDs/codes return
GROUP_EXISTS; stale revisions return BOOKING_CONFIGURATION_CONFLICT.

Changes apply immediately. Reject removing blocks used by non-cancelled orders
on dates today or later, or reducing limits below such reservations. Archival
requires zero linked products, even inactive ones. It prevents new assignments
while preserving allocations and capacity-checked reopening. Group deletion is
forbidden; the singleton cannot be deleted. No connector writes expose config.

`getBookingAvailability({day: 'YYYY-MM-DD', offset?: number})` requires Google
Staff OR Admin. Returns day, timeZone, settings `{blockMinutes, revision}`, up to
100 blocks and nextOffset (null at end). Each block contains groupId, groupCode,
groupName, archived, groupRevision, blockMinute, capacity, booked and remaining.
Counts/remaining are decimal strings to preserve Int64 values. Includes every
configured group/block, including archived groups and zero bookings. Order is
UUID then block minute. One repeatable-read snapshot covers settings/revisions/counts
within each page; changes between pages require refreshing before booking.

Connector reads under the same policy: GetBookingSettings, ListCapacityGroups,
ListOrderCapacityAllocations and ListOrderCapacitySummaries. Lists page at 100.
OrderCapacitySummary returns saved per-group quantities/name snapshots, separate
from StaffOrderSummary's financial totals. StaffOrderSummary also returns
`groupQuantities`, an array of `{groupId, groupName, quantity}` with decimal-string
quantities, so order lists need no per-order group downloads. Pig-only summaries
are removed.
Signed-in catalog reads retain their existing broader authorization.

## Concurrency, lifecycle and SQL guards

Capacity writers share a transaction-scoped `booking-capacity` advisory lock.
Services acquire it before source/parent locks; SQL statement triggers acquire
it before row locks on settings, groups, products, orders, items and allocations.
A global lock is intentionally simple for this restaurant's bounded workload.

Cancellation excludes occupancy without deleting allocations; completion retains
occupancy. Reopening uses saved groups and current schedule/limits, rejecting
removed blocks or full groups. Archived groups may reopen valid existing bookings.
Unmanaged grouped reopening and legacy unallocated grouped creation are blocked.
Existing managed item/schedule/total edit protections remain. Allocation inserts
validate the managed parent, date, group, block and capacity; deferred checks
require exact grouped item/allocation totals at commit. Never bypass guards by
chaining one-item writes. Group quantities and ledger sums aggregate independently.

## Runtime identity and grants

Reuse ORDERS_SQL_INSTANCE, ORDERS_SQL_DATABASE, ORDERS_SQL_USER and
ORDERS_RUNTIME_SERVICE_ACCOUNT and the dedicated Orders identity. Each of the four
Orders triggers uses maxInstances 1, concurrency 2, timeout 60s, pool max 2. With
three Staff triggers, the combined ceiling is fourteen connections against dev's
25 (three reserved). Review the combined budget before changing limits.

Grant Cloud SQL Client/Instance User, database CONNECT and schema USAGE. SQL grants:

- SELECT: product, client, customer_order, order_item, order_capacity_allocation,
  order_creation_request, order_action_request, payment, refund, booking_settings,
  capacity_group.
- INSERT: customer_order, order_item, order_capacity_allocation, order_creation_request,
  order_action_request, payment, order_audit_event, capacity_group.
- UPDATE customer_order columns: revision, status, final_total_cents, completed_at,
  updated_at.
- UPDATE booking_settings columns: block_minutes, revision, updated_at, updated_by.
- UPDATE capacity_group columns: name, capacity_per_block, archived, revision,
  updated_at, updated_by.
- EXECUTE on public.lock_order_creation_sources(uuid[],uuid), the pinned-search-path
  SECURITY DEFINER helper; PUBLIC execution is revoked. Product/client UPDATE is
  not needed. No DELETE/TRUNCATE, Staff-table or Auth-admin grants.

Migration identities remain separate from runtime. ORDERS_LOCAL_DATABASE_URL is
only accepted for demo-mtl with Auth emulator and loopback PostgreSQL, with no
remote host override. Tests isolate Functions dotenv from developer credentials.

## Local setup, checks and later rollout

Apply the matching GraphQL schema, then migrations/order-integrity.sql,
order-paid-status.sql, order-capacity-booking.sql and order-actions.sql in order
on a fresh local database. The capacity migration initializes only the singleton
schedule with [660,780,930,1080], preserving administrator edits on reruns.
It creates no capacity groups and supplies no default group limits. Google users
with both Staff and Admin claims create groups explicitly, for example:

```typescript
{action: 'CREATE_GROUP', id: '<new UUID>', code: 'MY_GROUP',
 name: 'My group', capacityPerBlock: 6}
```

Choose the capacity when creating the group, then link products using its returned
ID. Membership is never inferred from product names. Test suites create their own
groups through this admin API. No activation or setup script is required.

Use native Node 22 and a current Firebase CLI:

```sh
npm --prefix functions ci
firebase emulators:exec --only dataconnect --project demo-mtl "true"
npm --prefix functions test
npm --prefix functions run test:emulators
```

The last command runs Auth/Functions/SQL Connect, disposable native PostgreSQL,
and all connector/Staff/Orders suites. Coverage includes independent group limits,
splits, snapshots, permissions, restricted grants, safe/conflicting edits, stale
revisions, pagination, races, cancellation/reopening, actions and idempotent retries.

No cloud deployment/reset is implied. This replaces unreleased schema fields and
connector contracts; schemaValidation remains COMPATIBLE. Any future deployment
must explicitly review removals of old fields/table/view types and replacement SQL
guards. Do not blindly apply generated hardened-order diffs or discard native
constraints/audit triggers. Fresh local setups seed directly; release-specific data preservation is recorded below.
Regenerate/copy the Swift SDK and update app payloads/schedule reads together.
Review all seven flat exports before a codebase release; existing export names
are preserved. Use explicit --project for all cloud commands.

## Capacity groups deployed to dev — 2026-11-12

Passed ten unit tests, 83 isolated emulator/integration tests and standalone schema
validation before release. Reviewed the dev SQL diff and all five existing flat
exports before deploying the schema, staff-admin connector and four Orders functions.
The three Staff functions were preserved; all seven exports are ACTIVE with their
expected dedicated identities, maxInstances 1 and concurrency 2. Total pool ceiling
is fourteen against 25 database connections (three reserved).

Dev contained two products, six orders, six items, four roast allocations and six
creation requests. The release preserved every row: the existing lechon product
was assigned to LECHON with a revision increment, true item lechon snapshots became
saved LECHON group snapshots, and allocations were copied with stable IDs and exact
quantities. There were no inferred belly assignments, new orders, payment/status
writes or resets. Old physical fields/allocation rows remain as unexposed history;
the Orders runtime's privileges on the obsolete allocation table were revoked.

SQL Connect required a temporary superset schema to keep the old connector valid
while deploying its replacement. Registered the final group-only schema afterward.
Both final schema and connector sources were verified byte-for-byte against local
files with schemaValidation COMPATIBLE. A temporary write pause covered maintenance
and was removed only after verification. Generated constraint removals/cascading
FK replacements were not left applied: restored all eleven original native CHECKs
and RESTRICT FKs exactly, retained audit/identity immutability, and verified 22 enabled
booking/action/integrity guards. Existing payment/status protections remain active.

Verified the singleton schedule [660,780,930,1080], LECHON 18, PORK_BELLY 4, exact
runtime SELECT/INSERT grants and fifteen narrowly scoped UPDATE columns. No product/
client UPDATE or DELETE/TRUNCATE grants were added. Confirmed zero remaining
maintenance pauses and HTTP 401 UNAUTHENTICATED from all four Orders endpoints
for anonymous calls, without creating test orders or changing payments/status.
iOS must regenerate its SDK and
adopt the new group allocations, revisions and server-saved schedule before booking.

## Historical releases

The following records describe earlier deployments.

## Dev deployment verified 2026-11-09

Passed seven unit tests and 70 emulator/integration tests, including creation with
restricted runtime grants and rejection of unmanaged lechon reopening after
activation. Reviewed the dev SQL diff and applied only the additive tables,
indexes and columns. Registered the schema with COMPATIBLE validation during the
established transactional write pause; restored all eleven original native
constraints and resumed writes. Audit/identity immutability stayed enabled.
Applied the booking integrity migration with its disabled rollout row.

Created the dedicated `mtl-orders-functions` service account and Cloud SQL IAM
login, granted only Cloud SQL Client/Instance User plus the documented restricted
database access and helper EXECUTE, and verified no table UPDATE/DELETE/TRUNCATE
or Staff-table access. Deployed the staff-admin connector and `createStaffOrder`.
Then updated all four server Functions to one instance, concurrency two and pool
two after verifying dev's 25-connection limit (three reserved).

Read-only release checks confirmed that deployed GraphQL sources match the local
release, all four Functions are ACTIVE with the expected identities and limits,
all five native CHECKs, six RESTRICT foreign keys, three immutable-data triggers
and four booking guards are present, and the lock helper has its pinned search
path. There were zero orders before and after deployment; no cloud fixtures were
created. At that release, booking was still disabled by the former activation
gate. That historical release does not include the subsequent source change
removing the gate; deploy that update and reapply the booking migration. No
activation script is needed with the updated code.


## Activation removal deployed to dev 2026-11-09

Passed seven unit tests, 70 emulator/integration tests and the standalone SQL
Connect schema validation. Deployed only `functions:server:createStaffOrder` and
registered the updated schema with COMPATIBLE validation. Preserved all twelve
native constraint definitions and seven audit/identity/booking trigger definitions
through the established write-pause maintenance procedure.

Reapplied `migrations/order-roast-booking.sql` and deleted the obsolete activation
table in one transaction. The completed one-time cleanup script was then removed.
Verified the
obsolete table is absent, no database function references it, the deployed schema
matches local source and no maintenance guards remain. All four Functions are
ACTIVE with their expected identities, one instance and concurrency two. Orders,
items, allocations and creation requests remained at zero; no cloud fixtures
were created.


## Native cash payments, Paid and pickup

`updateStaffOrder` is an additive callable in northamerica-northeast1, with the same
Google staff-or-admin policy, ORDERS runtime identity and 60-second/one-instance/
two-concurrency/two-pool limits. Authorize before constructing the database pool.
The dev release is recorded below. Future deployments require an explicit request.

```typescript
{
  requestId: string; // stable UUID for this action; also the payment UUID for PAYMENT
  id: string; // order UUID
  expectedRevision: number;
  action: 'PAYMENT' | 'PAID' | 'PICKUP';
  amountCents?: number | null; // only PAYMENT: positive exact signed Int32 cents
}
```

PAYMENT accepts cash on Confirmed orders only. Overpayment is allowed and appears
as credit. PAID moves a Confirmed order to Paid at any balance, including when no
cash has been received. It preserves an agreed final total or finalizes subtotal
less discount, and creates no receipt. PICKUP requires Paid and changes it to
Completed with server time. Paid locks new receipts, and the balance stays visible
through pickup.

Every action locks the parent order, validates its revision, and saves the write,
audit and private OrderActionRequest identity/hash in one transaction. Request
locks serialize identical retries; mismatched actor/payload reuse fails without
exposing the previous result. Replaying a committed request succeeds even after
later lifecycle transitions. Never generate a new identity after an uncertain
result. Actor and timestamp are server-derived. Audit is append-only.

The native guards require the expected final total for Paid, Paid before pickup,
and Confirmed for new receipts. Parent row locks serialize receipts with lifecycle
actions. The legacy `MarkOrderPaid` mutation accepts unmanaged orders only.
Managed orders use the callable and its request ledger for safe retries.

For this update, the managed release applies `migrations/mark-paid-with-balance.sql`
after `migrations/order-actions.sql` and deploys both the staff-admin connector and
Functions. The update uses the existing OrderActionRequest table and ORDERS runtime
grants. The connector operation shape stays compatible with existing SDKs.

Action tests cover authorization, tampered/exact cents and overflow, overpayment,
paid/pickup guards, concurrency, transaction rollback, replay ownership, lost
responses and actual least-privilege runtime grants, alongside existing connector
and Functions suites on disposable local PostgreSQL.

## Native actions deployed to dev 2026-11-09

Passed eight unit tests, 75 emulator/integration tests and standalone SQL Connect
schema validation. Review fixed malformed action arrays passing string-coerced
validation, added explicit payment/pickup audit timestamps and pinned the new SQL
guards' search paths. Regression coverage includes discounted totals, successful
versus voided refunds, preservation of agreed totals, post-pickup retries and
repeatable migration application.

Reviewed the dev SQL diff and applied only the additive OrderActionRequest table.
Registered the schema with COMPATIBLE validation during the established write
pause, restoring all twelve native constraints exactly and preserving all seven
existing audit/identity/booking triggers. Applied order-actions.sql and granted
the existing ORDERS runtime SELECT on action requests/payment/refund, INSERT on
action requests/payment, and UPDATE only on the five documented order columns.
No product/client UPDATE or table-wide UPDATE/DELETE/TRUNCATE access was granted.

Deployed only functions:server:updateStaffOrder. Read-only verification confirmed
matching GraphQL sources, both new action guards, preserved native protections,
and all five Functions ACTIVE with their expected identities, one instance and
concurrency two. The new callable uses Node 22 and a 60-second timeout and rejects
anonymous calls. Existing counts remained three orders, three items, two roast
allocations and three creation requests. No cloud fixtures, live payments or
lifecycle changes were made for verification.

## Creation deposits release prerequisite (local change)

Deploy the compatible `createStaffOrder` before releasing the new iPhone form.
It uses the existing payment/audit tables, native payment guards and ORDERS runtime
SELECT/INSERT on payment plus UPDATE on order revision/updated_at. No schema
backfill or historical payment conversion is required. Existing requests retain
their canonical hash and requested-deposit semantics. This section documents local
code changes, not a cloud deployment.

iPhone submissions are journaled per approved account before transport. New order
restores the exact request after reopening and requires explicit retry; it never
automatically replays payments. Definite validation/capacity failures clear the
journal and return an editable draft; uncertain, access and request conflicts keep
it. Demo keeps independent recovery state in its fixture service.


## Native payment corrections

`updateStaffOrder` additionally accepts:

```json
{"requestId":"<UUID>","id":"<order UUID>","expectedRevision":3,"action":"PAYMENT_EDIT","amountCents":15000,"paymentId":"<receipt UUID>"}
```

The response remains `{id: <order UUID>}`. Existing actions omit paymentId; their
canonical hashes are unchanged. Idempotent committed retries check actor/hash
before current revision/status, including after receipt removal or later actions.
Staff OR Admin may correct successful CASH receipts on CONFIRMED/PAID. Admin alone
may correct COMPLETED/CANCELLED. Amounts are exact Int32 cents, from zero to the
receipt amount plus positive balance due. Balance uses saved final/subtotal less
discount, or cancellation total for CANCELLED, and successful receipts minus
successful refunds. Invalid amount is invalid-argument; stale revision is
ORDER_CONFLICT; invalid receipt/order/status is ORDER_LOCKED.

Positive corrections update the existing amount; zero marks the receipt VOIDED
while retaining its positive amount, timestamps and all refund links. Native UI
hides VOIDED receipts. Existing refunds remain unchanged even if they exceed a
corrected/removed receipt; negative net paid is allowed. No new refund UI or refund
mutation behavior is included, and legacy RefundCashPayment/VoidCashPayment keep
their existing checks. A PAID order left owing returns to CONFIRMED and retains
final_total_cents. Closed statuses never reopen. Parent revision, receipt, status,
PAYMENT_CORRECTED/PAYMENT_REMOVED audit and request commit atomically. Audits carry
before/after payment snapshots and status, signed by actor_uid. Original receipt
recorder and received_at remain intact.

### Release ordering (explicit operator action only)

1. Review/apply `migrations/payment-edits.sql` after `order-actions.sql`; it is
   repeatable and protects receipt identity and original timestamps. No table or
   connector changes are required. Preserve all earlier constraints and guards.
2. With the selected ORDERS runtime database role substituted, grant only:

   ```sql
   GRANT UPDATE(amount_cents,status) ON payment TO "<ORDERS runtime role>";
   ```

   Retain existing SELECT/INSERT/action and parent revision/status grants. Do not
   grant DELETE, identity/timestamp updates, or broad product/client writes.
3. Deploy only `functions:server:updateStaffOrder` with an explicit project after
   local validation, then release the app. This documentation does not authorize
   deployment, live role changes, or live money/status writes.

The iOS journal persists corrections per account/order before transport, freezes
uncertain/access failures across restarts and retries only on explicit taps.
Definite validation failures preserve drafts; conflicts require reload and review.
Run `npm --prefix functions test` and `npm --prefix functions run test:emulators`
with a native Node 22 runtime and current Firebase CLI. Tests target demo-mtl and
disposable native PostgreSQL, including actual restricted runtime grants.

### Deployed to dev 2026-11-15

Passed 12 unit tests and 90 emulator/integration tests using native Node 22.
Applied `migrations/payment-edits.sql` and granted the ORDERS runtime only
`UPDATE(amount_cents,status)` on payment. Verified all 137 existing database
constraints and all existing triggers were preserved.

Deployed only `functions:server:updateStaffOrder` to `dev` (`mtl-service-e3e0c`).
Verified the new function revision is ACTIVE, retains its dedicated ORDERS
identity, maxInstances 1 and concurrency 2, and rejects anonymous requests with
401 UNAUTHENTICATED. The other six deployed functions were unchanged. No live
payment or order status writes were used for verification.

This release targets new managed orders; legacy payment compatibility is outside
the release scope.

## Native active-order editing and cancellation

`updateStaffOrder` now accepts EDIT and CANCEL under the existing Google Staff OR
Admin policy. The existing endpoint/runtime budget is unchanged. Standalone
connector refunds retain admin-only authorization; only the atomic active-order
CANCEL permits staff to record cash already returned.

EDIT accepts `{action:"EDIT",requestId,id,expectedRevision,items,clientId,
contactPhoneNumber,scheduledFor,expectedSettingsRevision,expectedGroups,
allocations,notes}`. Remaining items carry `{id,productId,quantity}`; added items
also carry `expectedRevision`. Saved IDs retain name, prices, group snapshot,
creation timestamp and line notes. Reusing an ID for a different product is invalid.
Added products must be active at the requested revision. Client and phone must
match a current locked profile, or retain the unchanged saved client/phone snapshot.
No client requires a null phone. Quantities are 1–99 and exact Int32 totals cannot
fall below the saved discount. Payments, discounts and deposit fields are unchanged.

Both Confirmed and Paid may be edited. An existing agreed total follows the
reviewed subtotal less discount; Paid returns to Confirmed only when the ledger
no longer covers it. Unchanged pickup and exact placements may be past. Any
schedule change must satisfy future timing and the current block configuration.
Check capacity without own occupancy; unchanged/decreased slots may remain over a
lower historical limit and retain archived group snapshots. New/increased places
cannot use archived groups. Item totals, parent revision, replacements,
ORDER_EDITED before/after audit and request identity commit atomically.

CANCEL accepts `{action:"CANCEL",requestId,id,expectedRevision,refundAmountCents,
reason?}` (amountCents may be absent/null). The explicit refund is a nonnegative
safe integer no greater than net paid; the retained charge must fit nonnegative
Int32. Reason is optional, trimmed, at most 1,000 UTF-16 code units. Zero net paid
cancels with zero refund/charge. Negative net paid requires ledger correction.
Only Confirmed/Paid may cancel. Preserve original item values and final total;
set cancellation_total_cents to net paid minus this refund. Assign positive
SUCCEEDED refunds to successful CASH receipts oldest received_at then ID first,
subtracting successful prior refunds. Insufficient eligible cash rolls back.
ORDER_CANCELLED records refund identities/amounts, retained charge, reason,
server actor/time and before/after lifecycle. This records physical cash returned;
it never invokes a payment provider. Cancelled status releases occupancy while
allocation rows remain available for history.

Both actions share OrderActionRequest actor/canonical-payload ownership and the
order-action request lock. Matching committed retries return before current
revision/time/catalog checks. Old PAYMENT/PAID/PICKUP/PAYMENT_EDIT normalization
and stored hashes remain unchanged. Acquire booking-capacity before order and
receipt locks. Runtime or transport errors never authorize a new request identity.
The iOS account/order journal restores the exact submission for explicit retry;
no automatic replay or instruction to return cash again.

### Local migration and release sequence

1. Review/apply `migrations/order-edits.sql` after `payment-edits.sql`. It is
   repeatable and changes no connector operation or existing table shape.
   First review/deploy the additive NativeOrderEditContext @table schema using
   established compatible schema maintenance. Review the explicit-project SQL
   diff and preserve all native constraints/triggers; never apply a generated
   hardened-order diff wholesale. The schema addition has no connector operation.
   It adds a private native_order_edit_context table plus pinned-search-path
   routines. Only the definer edit routine can populate this context; no client
   role or caller-controlled session flag can enable the guard exception.
2. Use the trusted migration owner for function ownership. Keep PUBLIC and the
   SQL Connect runtime without EXECUTE on apply_native_order_edit, and keep all
   application roles without context-table privileges. Grant the selected ORDERS
   database runtime (substitute the actual role using identifier-safe SQL):

   ```sql
   GRANT EXECUTE ON FUNCTION public.apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb) TO orders_runtime;
   GRANT UPDATE(cancelled_at,cancellation_total_cents) ON public.customer_order TO orders_runtime;
   GRANT INSERT ON public.refund TO orders_runtime;
   ```

   Retain existing SELECT on client/product/order/items/configuration/allocations/
   payment/refund/action requests, UPDATE(amount_cents,status) on payment (needed
   for receipt locks), existing order-action INSERT and parent UPDATE grants, and
   EXECUTE on lock_order_creation_sources. Do not grant item/allocation DML,
   context-table access, or product/client UPDATE. The read-only predicate
   native_order_edit_allowed can be executed by guard callers but cannot open a
   context. Review future generated schema diffs to preserve this private table
   and native guards; reapply order-edits.sql last after any older booking migration.
   SQL Connect owner defaults can grant newly created tables/routines directly to
   its reader/writer roles. The migration explicitly revokes those private-context
   and edit-routine grants as well as PUBLIC access; verify effective privileges
   after maintenance rather than relying on PUBLIC revocation alone.
3. Deploy only compatible `updateStaffOrder`, with an explicit project, before
   releasing iOS. Deployment is a separate authorized operator action; none is
   performed by implementation or tests. No new endpoint, activation gate,
   bootstrap, backfill or generated SDK is needed.

Run `npm --prefix functions test` and `npm --prefix functions run test:emulators`
with native Node 22/current Firebase CLI. Tests use only demo-mtl emulators and
disposable PostgreSQL, including actual restricted runtime roles, rollback,
concurrent edits, saved snapshots, lowered historical limits, split/prior refunds,
negative net, cancellation capacity release and replay ownership.

### Deployed to dev 2026-11-16

Passed 14 unit tests, 98 emulator/integration tests and standalone SQL Connect
schema validation using native Node 22. The regression suite includes inherited
SQL Connect reader/writer privileges and repeatable private-access revocation.

Reviewed the explicit dev SQL diff. Added only NativeOrderEditContext through
COMPATIBLE schema maintenance with transactional write-pause guards, restoring
all existing native constraints before resuming writes. PostgreSQL flattened
redundant parentheses in the capacity CHECK without changing its predicates.
Applied `migrations/order-edits.sql` and the documented limited runtime grants;
verified all 137 existing constraints and 23 existing triggers were preserved.
Verified SQL Connect reader/writer roles have no private-context privileges or
edit-routine EXECUTE; only the migration owner and Orders runtime may execute
the edit routine. The Orders runtime has no context-table writes or product/client
UPDATE. The deployed connector was unchanged, and no maintenance guards remain.

Deployed only `functions:server:updateStaffOrder` to `dev` (`mtl-service-e3e0c`).
Verified its new revision is ACTIVE with the dedicated ORDERS identity,
maxInstances 1 and concurrency 2. Anonymous requests return 401 UNAUTHENTICATED;
the other six functions are unchanged. Verification performed no live payment,
refund or order lifecycle writes.
