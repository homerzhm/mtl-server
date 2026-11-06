# MTL server

This directory maintains and deploys Firebase services for the restaurant app. The current service is Firebase SQL Connect (`restaurant`), backed by Cloud SQL for PostgreSQL.

## Where to work

- Edit GraphQL schema sources under `dataconnect/schema/`. Add new tables as `@table` types.
- Use `dataconnect/dataconnect.yaml` for SQL Connect service and database settings, `firebase.json` for Firebase and emulator settings, and `.firebaserc` for project aliases.
- Keep generated emulator files, debug logs, and credentials out of source control.

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
