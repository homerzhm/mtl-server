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

## Local verification

Use an ARM-compatible Node installation and current Firebase CLI (tested with
firebase-tools 15.35.0 / SQL Connect emulator 3.4.25). Then run:

```sh
firebase emulators:exec --only dataconnect --project demo-mtl "node --test tests/products.test.mjs"
```

Tests use unsigned Firebase tokens accepted only by the local emulator and never
send requests to the cloud. They cover authorization for every operation, exact
cents, optional fields, soft hiding, duplicate names, zero price, validation
rollback, concurrent updates, missing rows, and description preservation.

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
