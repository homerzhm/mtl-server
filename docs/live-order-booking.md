# Native live order creation and roast booking

This revision is deployed to dev (`mtl-service-e3e0c`), including removal of the
activation gate and obsolete table. There is no booking setup or enable step.
The iOS Orders tab requires these changes before creation can be used. Existing
order editing, receipt and lifecycle APIs remain separate from this creation flow.

## Callable contract

`createStaffOrder` is a flat Firebase callable export in `northamerica-northeast1`.
It requires Google authentication and strict Boolean `staff:true` OR `admin:true`.
Authorization runs before database construction. Runtime limits are 60 seconds,
one instance, two concurrent requests and two database connections per instance.
Each of the three Staff functions uses the same instance/concurrency/pool limits.
Their combined worst-case pool budget is eight connections; dev allows 25 total,
with three reserved for superusers. Leave the remaining capacity for SQL Connect,
maintenance and other clients. Review the combined budget before raising limits.

Input fields are required, using explicit null for optional contact/client/notes:

```typescript
{
  id: string; // stable UUID, also the idempotency key
  items: Array<{
    id: string; // stable item UUID
    productId: string;
    expectedRevision: number;
    quantity: number; // 1–99
  }>;
  clientId: string | null;
  contactPhoneNumber: string | null;
  scheduledFor: string; // UTC ISO timestamp, seconds zero, 15-minute local time
  allocations: Array<{minute: number; pigs: number}>;
  depositRequiredCents: number;
  notes: string | null;
}
```

At most 100 distinct products, one line per product. The UI copies a linked
client's phone before submission; the callable preserves the explicit snapshot,
including null, rather than silently substituting changed profile data. Phone
input accepts ten unformatted NANP digits or canonical international `+` form;
iOS normalizes formatted input with MTLCore. Notes are limited to 10,000 characters.
Amounts and multiplication must fit nonnegative signed 32-bit CAD cents. Requested
deposit is from zero through subtotal. No payment, discount or final total is
created; the initial lifecycle is CONFIRMED and balance is an estimate.

The response is `{id: string}`. Fetch the detail through SQL Connect after success.
Creation saves every item, product name/price/lechon snapshot, allocations,
idempotency record and automatic audit event in one PostgreSQL transaction.
Server-side catalog reads lock selected products and reject inactive/missing or
revision-changed products. Order-number generation retries unique collisions.

The request hash uses validated canonical input, sorted item IDs and block minutes.
The actor UID comes from trusted callable auth. A matching retry returns its
original order before revalidating now-expired timing or a changed catalog.
Reusing the UUID with different content or another actor returns REQUEST_CONFLICT,
without exposing the existing record. An uncertain response must be retried with
the exact payload and IDs; do not start a replacement request automatically.

Expected failures include CATALOG_CHANGED, ROAST_CAPACITY, PICKUP_EXPIRED,
CLIENT_UNAVAILABLE and REQUEST_CONFLICT. Unexpected errors
are logged server-side and sanitized as an uncertain result. iOS freezes that
pending payload until reconciliation, while known rejected writes retain an
editable draft.

## Fixed booking rules and integrity

App and server constants match: America/Toronto, every day at minute offsets
660, 780, 930 and 1080 (11:00, 13:00, 15:30 and 18:00), capacity 18 pigs per block.
One lechon quantity uses one place regardless of size. Splits are allowed within
the pickup day and must exactly equal the pig quantity. Pickup cannot precede the
last allocated block. Both pickup and allocated block starts must still be future
at commit; there is no advance-booking horizon or staff override. Add-on-only
orders have no allocations and may book on full roast days.

Creation acquires transaction-scoped advisory locks keyed by `roast:YYYY-MM-DD`.
SQL triggers acquire those same locks for cancellation and reopening; reopening
checks the resulting occupancy. Completed orders retain their places. Cancelled
orders retain allocation history but no longer consume capacity. Existing order
item/schedule mutations reject booking-managed orders, including add-on-only ones.
The old one-item creation path cannot create unallocated active
lechon orders. Reopening cancelled/completed unmanaged lechon orders is also
blocked unless allocations have been handled through an allocation-aware workflow. Legacy
orders remain readable.

The schema adds a nullable item lechon snapshot, booking-managed flag, allocation
and request tables. Unknown legacy lechon counts remain null. No activation
table or runtime activation permission is required.
`StaffOrderSummary` and `RoastAvailability` are SQL Connect query-backed types,
not physical PostgreSQL views. Summaries aggregate items and financial data without
per-order downloads and without multiplying payment/refund joins. Number and phone
search use separate exact-filter operations; nullable equality filters must not be
used to represent unfiltered browsing. All reads require the existing Google
staff-or-admin policy and paginate at 100 using stable ordering and raw offsets.

## Configuration and IAM

Use a dedicated runtime service account and PostgreSQL IAM login, separate from
Staff role administration. Configure the topic parameters in deployment dotenv:

```text
ORDERS_SQL_INSTANCE=<project:region:instance>
ORDERS_SQL_DATABASE=restaurant
ORDERS_SQL_USER=<dedicated PostgreSQL IAM login>
ORDERS_RUNTIME_SERVICE_ACCOUNT=<dedicated service account email>
```

Enable Cloud SQL IAM authentication and grant Cloud SQL Client and Cloud SQL
Instance User to that identity. Give it CONNECT to the database, USAGE on public,
SELECT on product, client, customer_order, order_item, order_roast_allocation,
order_creation_request, and INSERT on customer_order,
order_item, order_roast_allocation, order_creation_request and order_audit_event.
Grant EXECUTE on `public.lock_order_creation_sources(uuid[],uuid)` to the runtime
login. This SECURITY DEFINER helper takes product/client row locks with its trusted
owner's permissions, uses a pinned search path and is not executable by PUBLIC.
The runtime needs no role-admin or Auth-admin grants and no UPDATE/DELETE/TRUNCATE
grants. Test creation under these restricted grants, not only as a database owner.
Use a separate trusted migration identity for schema and SQL maintenance.
Keep that identity out of the deployed callable. Verify effective
privileges, including inherited/public grants, rather than only adding grants.

`ORDERS_LOCAL_DATABASE_URL` is only for demo-mtl emulators and a loopback database;
it fails closed for cloud projects, missing Auth emulator configuration, remote
hosts, alternate SSL modes or extra connection parameters. Never deploy this
local variable. Local tests isolate Functions dotenv settings from developer files.

## Reviewed rollout sequence — explicit deployment required

1. Review the compatible additive schema diff. Preserve all native integrity
   constraints, immutable audit/identity triggers and RESTRICT relationships.
   Do not apply a generated hardened-order SQL diff blindly.
2. Apply the additive GraphQL schema, then the repeatable
   `migrations/order-roast-booking.sql` migration. It creates the additional
   protections. Reapply it on existing environments to remove old flag-dependent
   guards. It does not read or seed an activation flag.
3. Set up the dedicated IAM/database identities and ORDERS parameters. Regenerate
   the Swift SDK, copy it into iOS, run its preparation script and regenerate Tuist.
4. Deploy connector additions and only `functions:server:createStaffOrder` to an
   explicitly selected project. Review the full export inventory before any
   codebase-wide deployment; preserve existing Staff exports.
5. Release/verify the iOS integration after backend deployment. No activation
   script, flag update or fresh-environment check is required. Cloud smoke checks
   and test-order creation require a separate explicit request. Do not change
   live roles for validation.

The obsolete activation table has already been removed from dev. Fresh
environments do not create it. Preserve allocation history, managed flags and
integrity triggers; do not apply generated native-constraint changes.

## Local checks

Use native Node 22. Run `npm --prefix functions test` and
`npm --prefix functions run test:emulators`. The latter uses Auth, Functions and
SQL Connect emulators with disposable native PostgreSQL, never cloud endpoints.
Tests cover real callable HTTP auth, transactions and rollback, duplicate/lost
response retries, changed-payload and actor conflicts, catalog changes, exact
search, product snapshots, cancellation/reopening capacity, simultaneous last-place
competition and overflow/deposit validation. Creation runs against a schema
without an activation table, including under restricted runtime grants.
The existing product/client/order/client-history and Staff suites run alongside it.


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
