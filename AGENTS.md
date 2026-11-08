# MTL server

This directory maintains and deploys Firebase services for the restaurant app. The current service is Firebase SQL Connect (`restaurant`), backed by Cloud SQL for PostgreSQL.

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

## Product conventions

- Each `Product` row represents one sellable menu item. Store its fixed selling price as integer CAD cents in `priceCents`.
- Use `isActive` for whether the item is offered on the menu and can be ordered. Sold-out status is managed outside `Product`.
- Use the required `isLechon` flag to identify lechon products; it defaults to `false`.

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

- Client operations live under `dataconnect/staff-admin/`. List and get require
  a signed-in user. Create and update require Google sign-in and Boolean
  `staff:true` and `admin:true` claims.
- Product prices are nonnegative signed 32-bit CAD cents. Keep optional Chinese
  names; preserve descriptions and creation timestamps during editor updates.
- Updates must atomically match and increment `revision`; do not use upsert for
  existing-product edits. The dependent post-write lookups are intentional.
- Run `firebase emulators:exec --only dataconnect --project demo-mtl "node --test tests/products.test.mjs tests/clients.test.mjs"`
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
