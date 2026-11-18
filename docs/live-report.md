# Live admin Report

Report is a standalone manually entered CAD ledger. Its two tables start empty in
each environment. The iOS app calculates totals from active entries and uses a
Toronto business date. Stored instants are server-generated UTC timestamps.

## Callable contract

`manageReportEntries` requires Google sign-in and Boolean `admin: true`. The
request includes `actorID` matching the verified Firebase UID to bind each action
to the session that initiated it. Identity and display name come from the token,
with email and UID as display fallbacks. The current entry retains its creator
when edited by another admin.

- `list` takes `startDay`, exclusive `endDay`, and optional `after` containing
  `day` and `id`. Dates use `YYYY-MM-DD`. The response has up to 100 active
  `entries` and the next cursor or null.
- `create`, `update` and `delete` take `change` with the matching action,
  `requestID` and `entryID`. Create supplies day, type, signed integer
  `amountCents` and optional notes. Update supplies `expectedRevision`, amount
  and replacement notes. Delete supplies `expectedRevision`.
- The entry and its audit revision commit together. An identical retry returns
  the snapshot originally committed, even after another change on that entry.
  Deleted entries are tombstones with their full prior values retained. Review
  previous values through trusted database access to `report_entry_change`,
  ordered by revision for a given `entry_id`.

## Backend-first release

1. Provision a separate Report Cloud Functions runtime service account and Cloud
   SQL IAM database user in each target. Give the runtime Cloud SQL Client and
   Cloud SQL Instance User access and the SQL role database CONNECT and public
   schema USAGE. The release operator needs act-as permission and the existing
   schema-owner role. Configure the five `REPORT_*` cloud parameters in the
   project-specific Functions dotenv using `functions/.env.example` and the
   target's existing region. The callable has one instance, concurrency two and
   a two-connection pool, adding at most two connections to the server budget.
2. Follow the [managed release runbook](releases.md) and review the target's SQL
   diff. The Report maintenance pre-creates the two tables and registers the
   shared schema through the existing guarded native-constraint procedure.
   Special-day writes pause while its capacity check is temporarily removed for
   schema validation. The saved check and write guard are restored if
   registration fails, and an interrupted process can resume from the snapshot.
   Verification covers the table definitions, native constraints and effective
   grants. The Report runtime can read and insert both tables and update just
   amount, notes, revision and deletion time on the entry. Connector identities
   have no Report table access. The managed release then deploys the callable.
3. Verify the exact release in Development first with an authorized test
   account. Check that a Google staff-only account cannot call Report, then
   verify list, add, edit, delete, and replay as a Google admin. Use disposable
   Development entries. Follow the runbook for production promotion before
   distributing the iOS build for that environment.

Local validation uses the schema emulator, Functions unit and emulator suites,
and managed release tests. The emulators require project `demo-mtl` and a
disposable loopback database.
