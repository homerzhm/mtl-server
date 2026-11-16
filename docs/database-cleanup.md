# Database cleanup review before production

Reviewed repository schema, connector fragments/mutations/queries, native SQL,
Functions, tests, and sibling iOS source/generated SDK on 2026-11-16. This is a
source dependency review; no live database was inspected or changed. There is no
confirmed safe field/table deletion. Production should start from the shared
current schema, without importing dev data.

## Physical objects to retain

| Objects | Current dependency / reason |
| --- | --- |
| product, client | Catalog/contact connector, native creation/edit source locks, iOS directories |
| customer_order, order_item | Native and legacy connector contracts, snapshots, history, totals |
| payment, refund, order_audit_event | Cash ledger, corrections/cancellations, immutable financial history |
| booking_settings, capacity_group, order_capacity_allocation | Admin configuration, shared capacity enforcement, historical placement snapshots |
| order_creation_request, order_action_request | Actor/payload ownership and retry safety; deleting these enables duplicate writes |
| staff_account, staff_role_change, staff_role_control | Current roles, durable Auth synchronization, last-admin protection and serialization |
| native_order_edit_context | Private transaction capability for restricted SQL edits; absence of client access is intentional |
| mtl_operations metadata | New operator-only release/migration tracking, not an application table |

ClientDirectoryEntry, StaffOrderSummary, OrderCapacitySummary,
OrderFinancialSummary and PaymentRefundSummary are query-backed GraphQL types,
not physical SQL views/tables to delete.

## Field candidates investigated

| Candidate | Evidence | Decision |
| --- | --- | --- |
| depositRequiredCents | Callable canonical input/hash; connector pricing/fragments; iOS LiveOrderCreateRequest and payment detail | Retain: historical meaning and active API compatibility |
| Payment.provider/providerReference | Payment connector fragment/generated SDK; unique/check constraints explicitly keep cash-only values null | Retain: removal breaks existing operation/SDK shape and native definitions |
| fulfillmentType | Order connector fragment/generated SDK, native INSERT and PICKUP-only CHECK | Retain: fixed value still part of contract |
| bookingManaged | Native SQL guards distinguish managed orders from legacy mutations | Retain: enforcement boundary |
| Product.description | Connector returns it; editor updates deliberately preserve it; regression coverage | Retain: not unused just because editor cannot change it |
| Item prices/names/group snapshots | Historical summaries, edit rules and occupancy reopening use saved values | Retain: history must survive catalog changes |
| Request hashes, revisions, timestamps | Concurrency, retry ownership, pagination and audit | Retain |

Obsolete lechon-specific columns/allocation/activation tables are absent from the
current GraphQL schema. Historical dev release records document their prior
removal. A live catalog audit must confirm no leftovers or grants remain; absence
of source references alone does not authorize dropping a live historical table.

## Initial-data review

The production migration path inserts only singleton booking hours
11:00/13:00/15:30/18:00 Toronto time. It does not insert groups, limits, products,
clients, orders, receipts or refunds. Staff creates the role-control singleton on
first use; explicit administrator setup creates genuine account/audit records.
Test suites create fixtures only in disposable demo-mtl databases. Their seeding
must not be copied into provisioning code.

## Live audit and removal criteria

Run the documented `release:audit` command after an explicit operator request.
It reads catalog columns/defaults, constraints, indexes, triggers/enabled state,
routines/definitions, and table/column/routine grants. Compare that inventory with
`release/database-contract.json` and inspect pg_depend plus application operations
for every proposed obsolete object. Obtain aggregate counts/null rates when needed
without exporting customer content. Do not infer disuse solely from zero rows.

Any eventual deletion needs an exact object list, source and SQL dependency
analysis, iOS compatibility assessment, existing-row preservation strategy, and
reviewed maintenance SQL tested locally and verified in dev. Keep destructive
entries blocked from routine promotion. Do not reset dev, weaken constraints,
remove audit history or apply a generated hardened-schema diff wholesale.

## Remaining production readiness

- Live resource/database parity, effective IAM and existing obsolete-object checks
  are not yet performed; see releases.md for the one-time checklist.
- Native SQL definition comparisons are intentionally strict. PostgreSQL version
  formatting differences must be reviewed, not silently accepted or auto-dropped.
- Locked dependency installation currently reports 12 moderate vulnerabilities.
  Triage the current npm audit report before production; no automatic breaking
  dependency upgrades or lockfile changes are part of this implementation.

### Live readiness audit follow-up

The initial dev contract audit found the item/group FK still used SET NULL.
`restore-item-capacity-reference.sql` repairs it to the reviewed RESTRICT rule
without changing rows or disabling audit triggers. A separate capacity CHECK
formatting difference is explicitly allow-listed: PostgreSQL flattened redundant
AND parentheses while retaining every predicate. No table/column is removed.
