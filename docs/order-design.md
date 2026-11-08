# Order design

Implemented in the SQL Connect schema and staff-admin connector, and deployed to
dev on 2026-11-07 with native PostgreSQL protections verified. This document
records the workflow and implementation decisions. See README.md for operation
contracts and the schema-deployment caveat around the separate integrity
migration. Production has not been deployed.

## Agreed workflow

- Pickup only initially. Delivery and dine-in can be added when their workflows
  are defined.
- Orders can belong to a saved client or an anonymous walk-in.
- Statuses are `CONFIRMED`, `PAID`, `COMPLETED`, and `CANCELLED`, without a draft
  status or kitchen preparation stages. The manual PAID update was deployed to
  dev on 2026-11-07.
- Staff/admin manually mark a confirmed order PAID with the UI button backed by
  `MarkOrderPaid(id, expectedRevision)`. No receipt is created or balance checked.
  Payments, refunds, and price changes do not automatically toggle the status.
  Paid orders remain active/editable like confirmed orders; the financial ledger
  independently supplies the numeric balance. Admin reopening can undo a paid
  mark without modifying payments, and every transition is audited.
- Completion means the customer collected the order. An unpaid balance must not
  block completion or require an override reason. Both CONFIRMED and PAID can
  transition directly to COMPLETED or CANCELLED with the existing role rules.
- Staff choose the requested deposit amount. Record actual payments separately;
  a requested deposit is not money received.
- Cash is the main initial payment method. Future payment integrations may
  include Stripe or another provider.
- Cancellation may result in a full refund, partial refund, or retained payment.
  Staff decide the settlement, including any remaining amount owed. Cancellation
  must not automatically clear a balance or create a refund. Completed-order
  financial changes retain the admin requirement.
- Staff can edit confirmed or paid orders, including items and prices, after a payment.
  Preserve payments, recalculate the balance, and expose overpayments without
  automatically refunding them.
- Completed orders remain editable with action-specific authorization. Financial
  changes require admin access; staff can assign a client without admin access.
  Editing a completed order does not implicitly reopen it or change its original
  completion timestamp.
- Quantities are positive whole numbers. Staff can override selling prices.
- Menu prices are before tax. Initially there is no automatic tax calculation:
  staff enter the agreed final total at checkout. Do not infer a tax amount or
  exemption from the difference between item subtotal and the entered total.
- Fixed-amount and percentage discounts are desired; percentage entry can be
  added later while retaining the calculated discount amount in cents.

## Pickup identification and search

Use a UUID as the internal order identity and a separate permanent `orderNumber`
for the printed customer paper. The format is six uppercase letters
and digits, excluding `0`, `O`, `1`, `I`, and `L`.

The order number is required, unique across all orders, and unchanged by edits,
completion, or cancellation. Do not reuse it. Generate a random code and retry
creation on a collision with the order-number unique constraint. Normalize
lookup input to uppercase. Staff lookups require authorization; the code does
not grant API access.

Staff can find an order by order number or phone number. Customer-name search is
not needed. Phone search returns multiple matching orders when applicable.

Store these independently on each order:

| Field | Meaning |
| --- | --- |
| `clientId` | Optional foreign key to a saved client |
| `contactPhoneNumber` | Optional order-specific contact phone number |

For a saved client, copy their current phone number into the order at creation.
Later client edits must not silently change an existing order's contact number.
Staff can correct the order contact explicitly. A walk-in can supply a phone
number without creating a client; an anonymous walk-in can leave both fields
empty and use the paper's order number.

Apply the existing client phone rules to order writes and lookup input:

- Normalize exactly ten Canadian/default NANP digits to `+1` plus those digits.
- Otherwise require canonical international form: `+` followed by 2–15 digits,
  beginning with a nonzero digit.
- Null means no contact number; do not store an empty string.
- Index `contactPhoneNumber` for exact lookup; do not make it unique.

## Relational model

| Table | Responsibility |
| --- | --- |
| `Order` | Identity, contact snapshot, fulfillment, lifecycle, agreed totals, revision, timestamps |
| `OrderItem` | Order/product relationships, saved product name and prices, quantity, notes |
| `Payment` | Individual payment amounts, methods, lifecycle, received time, integration references |
| `Refund` | Individual refunds linked to their original payment, amounts and lifecycle |

Use separate UUIDs for order items. The same product may appear on multiple
lines with different instructions or prices. Preserve the catalog price at the
time of ordering and the actual agreed unit price. Later product edits must not
change historical order values.

Use integer CAD cents and exact arithmetic. Check multiplication and aggregate
totals for overflow. Store the agreed final amount so historical receipts do not
depend on current settings. Automated tax rates and separate tax calculations
are deferred.

The initial discount model is an order-level fixed amount in cents.
Per-item price overrides provide line-level flexibility. Percentage entry can
later retain its input percentage alongside the final computed cents amount.

### Manual checkout and cancellation settlement

Use `finalTotalCents` as the staff-entered nonnegative final amount, nullable
until agreed, alongside the calculated item subtotal and discount. Clearly label
pre-finalization balances as estimates. Payments and completion can occur before
finalization; do not introduce a payment or checkout gate on completion.

Once entered, do not silently overwrite the final total when items change.
Staff must explicitly save a changed agreed final total; after completion this
requires admin access. A future automatic tax breakdown can be additive. Do not
present the unexplained difference from subtotal as tax.

On cancellation, save a nonnegative `cancellationTotalCents`: the
staff-selected final charge for the cancelled order, including any agreed amount
retained or still owed. Preserve the original final total and item values for
history. Cancellation requires an explicit settlement amount, not an automatic
zero/default. Use this amount for the cancelled order's balance; record any
actual refund separately.

For example, with $100 received: a $100 cancellation charge and no refund retains
the payment; a $0 charge and $100 refund settles a full refund; a $150 charge
leaves $50 owing. Refunds remain explicit actions subject to refund permissions.

## Completed-order access control

Agreed: money-related edits to completed orders require admin access; assigning
a client requires staff access. The implemented policy is:

| Action on a completed order | Access |
| --- | --- |
| Assign, replace, or remove a client link | Staff or admin |
| Correct the order contact phone or add an internal note | Staff or admin |
| Change products, quantities, unit prices, discounts, final total, cancellation charge, or deposit requirement | Admin |
| Record a newly received payment against the remaining balance | Staff or admin; separate receipt operation |
| Correct an existing payment or issue a refund | Admin; preserve the original record |
| Reopen or cancel a completed order | Admin; explicit lifecycle operation |

Financial permission is based on the action, including products and quantities,
not just fields whose names contain a monetary amount. Client assignment must
not trigger repricing, final-total changes, or payment reassignment. Preserve the
order contact snapshot unless staff explicitly change it as part of the allowed
contact operation.

Implement separate narrowly scoped mutations for contact changes, financial
changes, receipt recording, refunds/corrections, and lifecycle changes. Enforce
authorization in the connector/backend using trusted authentication claims;
hiding UI controls is insufficient. Preserve existing Google sign-in policy.
For order operations, the staff capability accepts Boolean `staff:true`
OR `admin:true`; admin-only actions require Boolean `admin:true`. Existing
product and client permissions remain unchanged.

Any status-dependent authorization must check the stored status atomically with
the revision-checked write. A staff financial edit started before completion
must not succeed after a concurrent completion by using stale status data.

Audit history is required and automatic, without a reason field or extra form
step. Audit records are append-only and written in the same transaction as the
change. Include order ID, actor UID from trusted auth, server timestamp, action,
revision, and before/after changed values. Do not allow staff to edit audit
records or silently overwrite/delete successful payments; model corrections
separately.

### Audit storage

Use an `OrderAuditEvent` table, separate from current order/item/payment state.
One event represents one successful business action, potentially changing
multiple rows. This is history for review, not a requirement to rebuild orders
by replaying events.

| Field | Purpose |
| --- | --- |
| `id` | UUID for the event |
| `orderId` | Required foreign key to the order; no cascading deletion |
| `action` | Structured action such as `ORDER_CLIENT_ASSIGNED` or `ORDER_PRICING_CHANGED` |
| `actorUid` | Trusted authenticated user UID; allow explicitly identified system actors for future integrations |
| `occurredAt` | Server-assigned timestamp |
| `orderRevision` | Resulting revision, providing deterministic per-order event ordering |
| `changes` | Structured before/after data, PostgreSQL `jsonb` |

No audit-specific input is required from the frontend. It submits the normal
business action; the backend constructs the event automatically. Do not add a
separate frontend request to save history. A structured payload version can be
added later if the change format evolves.

Keep frequently filtered metadata in typed columns. Events store relevant changed
fields, not full order snapshots on every edit. Creation stores the initial
header/item; item/payment/refund events include
the affected row IDs and snapshots. Timestamps in JSON are explicitly serialized
as strings. In future bulk operations, array entries must identify
rows by stable IDs rather than list positions. Do not log card details, auth
tokens, or entire external provider payloads. Contact-change history is sensitive
and needs the same access discipline as order contacts.

Build before/after values from trusted database reads and successful writes, not
from caller-supplied history or descriptions. Check the expected order revision,
write the business changes, increment the revision, and insert the event in one
transaction. Roll back everything if any step fails. Extend this serialization
rule to payment/refund operations that produce order events. A revision check
must ensure any pre-write snapshot still matches the state being changed.

Use one event per revision and a unique `(orderId, orderRevision)` constraint.
Handle retry deduplication at the business-operation boundary rather than
requiring an audit-specific operation ID field. Stable payment/refund UUIDs
prevent duplicate receipts/refunds. A retry with an already committed ID fails
rather than replaying success; callers inspect the
ledger after an uncertain outcome before generating any new ID. All mutation
snapshots and writes use explicit server-side response dependencies.

Record creation, item/pricing/final-total edits, contact/client changes, completion,
cancellation, payments, refunds, and corrections. Do not create a business-change
event for failed writes or ordinary reads; security/access logging is separate.

Read events by order in revision order. The unique order/revision index supports
that timeline; add other indexes only for real queries. Do not expose standalone
audit insert/update/delete operations to clients. Even app admins cannot edit
history through the app. This is application-level append-only history, not a
claim of protection against privileged database administrators. Restrict any
direct SQL maintenance and ensure it follows the same audit policy.

## Integrity and concurrency

- Use foreign keys for relationships, required fields for required values, and
  row constraints for valid amounts, positive quantities, and status/timestamp
  consistency where supported by the managed schema tooling.
- Save order/item changes and recalculated totals atomically. Match and increment
  the order revision so concurrent edits do not overwrite one another.
- Validate cross-row rules, including aggregate refunds against the original
  successful payment, with transactional concurrency control rather than a
  cross-table `CHECK` constraint.
- Derive net paid from successful payments minus successful refunds. Do not
  maintain independently editable paid/balance fields.
- Display overpayment explicitly; do not silently clamp a negative balance to
  zero or issue an automatic refund.
- Provider references must prevent duplicate recording of the same external
  transaction when integrations are introduced.
- Index lookup relationships and list queries according to their actual access
  patterns. PostgreSQL does not automatically index referencing foreign keys.
- Preserve payment and refund history. Define corrections and audit behavior
  before exposing financial mutations.

## Implementation defaults and verification

- Include nullable `scheduledFor`; no scheduling mode field is needed.
- Start with fixed order-level discounts and per-item price overrides.
- Staff or admins can manage confirmed/paid orders and record newly received cash.
  Admins perform corrections/refunds and financial changes after completion.
  Preserve existing product and client permissions.
- Cancelled-order changes/reopening are admin only. Staff can still record money
  received on a cancelled order.
- Cash receipts/refunds are SUCCEEDED or VOIDED. Corrections void the original
  record; corrected amounts are new records. System actors and external-provider
  status handling are deferred until a trusted integration is added.
- Automatic audit history has no reason field or extra frontend request.
- Automatic tax and percentage-discount entry are future work.

The additive schema and connector operations have emulator coverage. Native
CHECK constraints, RESTRICT delete rules, immutable order identity, and audit
immutability triggers are in `migrations/order-integrity.sql`, tested separately
against local PostgreSQL. They are not applied automatically by Firebase deploy.
COMPATIBLE validation rejects these custom CHECK/FK definitions during schema
deployment. Review README.md and the generated SQL before future releases; do
not accept destructive removal of protections without a controlled maintenance
procedure. Connector-only deployments can avoid schema validation/migration.
The manual PAID update uses `migrations/order-paid-status.sql` to broaden the
existing status CHECK before a connector-only release; the initial integrity
file also permits PAID when initializing a new database. No new timestamp field
is needed: the paid-mark audit event supplies the actor and time.
