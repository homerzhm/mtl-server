# Special days release

This release adds an empty `special_day_rule` table and a read-only, admin-authorized
connector operation. The maintenance migration creates the table and indexes and
grants the Orders runtime access before registering the compatible SQL Connect
schema. Non-interactive Firebase schema registration requires the table to exist.
The following transaction adds the validation and booking lock, then replaces the
active allocation, group and managed reopening guard bodies. Orders, allocations
and capacity groups require no data migration.

Review the target's schema diff before starting. In addition to the special-day
table and indexes, SQL Connect can report the private edit context as missing
and propose dropping native CHECKs and replacing RESTRICT foreign keys. Use the
reviewed write pause in migration 008. It snapshots the exact definitions in
the private release schema, pauses order-related writes, and temporarily presents
the definitions required for registration. SQL Connect receives temporary SELECT
access to the private edit context for validation. The migration restores the
constraints, revokes that access, and removes the pause in one transaction, even
when Firebase registration returns an error. If the process is terminated during
the pause, rerun the same release promptly to resume from the saved definitions.
Investigate any proposed changes outside the migration's explicit allowlist.
The release runner deploys the matching connector and Functions after database
contract verification.

Ship the matching Staff build after the backend is ready. Before admins add rules,
coordinate the Staff update with devices in use. Older builds can fail to load
availability for a month containing a day with an effective special limit. Check
Calendar, New order, Edit order and Block capacity in Development first. Nothing
in local validation deploys or creates live rules.
