# Firebase app operations

Source of truth is the current server checkout, especially `docs/live-order-booking.md`, `dataconnect/staff-admin/{queries,clients-queries,orders-queries,booking-queries,mutations}.gql`, and `functions/src/orders/{handlers,booking,service,permissions}.ts`. Production is Toronto; older documentation may describe the Montréal Dev endpoint. No deployments are part of this workflow.

## Helper

Use native Node 22. On this machine an available native binary is `/Users/hongmingzuo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`; verify it still exists. The nvm v22.8.0 binary may fail with `Bad CPU type`.

Set `MTL_FIREBASE_SESSION_FILE` to an absolute private JSON file produced by a legitimate Firebase Google sign-in for the selected environment. Its fields are `projectId`, `apiKey` (the selected app's Firebase API key), and `idToken` (the current Firebase user ID token). The file must be owned by the current OS user with mode 0600. Never ask for credentials in chat; provide any session through a secure local app/login integration. Tokens expire: obtain a refreshed token from the signed-in app when needed, keeping the same Firebase actor UID for reconciliation. The request helper does not provision Google OAuth clients. For interactive sign-in, use the companion script below.

**Initial setup status:** the existing CLI login was tested against Dev on 2026-11-16. Firebase rejected the Google token with `INVALID_IDP_RESPONSE: access_token audience is not for this project`. Do not repeat this exchange or treat a Firebase CLI OAuth access token as an app ID token. The companion interactive sign-in subsequently succeeded for the existing Dev user; exact phone lookup, phone order lookup, catalog read and getBookingAvailability were verified live. Use interactive sign-in when the session expires. Do not weaken checks, create Auth users, change OAuth/IAM settings, or mint custom tokens.

### Interactive Google sign-in

Set `MTL_FIREBASE_CLI` to the real installed `firebase-tools/lib/bin/firebase.js`; initially `/Users/hongmingzuo/.nvm/versions/node/v22.8.0/lib/node_modules/firebase-tools/lib/bin/firebase.js`. Run:

```sh
node <skill>/scripts/sign-in.mjs dev /absolute/private/path/sessions/dev.json
```

Use `production` only after explicit environment selection. The script reads the selected project's registered iOS configuration and authorized domains through the existing CLI account, starts a loopback-only sign-in page, and prints a random localhost URL. Open that URL in the user's normal browser (Safari worked), then sign in as `homerzhm@gmail.com`. It uses the official Firebase Web SDK Google popup flow with `autoCreate: false` on the provider exchange, verifies the returned session against Firebase, checks the expected account/project/provider/roles, and writes only a short-lived ID token plus app configuration to the private file. It does not save Google/Firebase refresh tokens. It changes no OAuth settings or business data. If localhost is not already authorized, report that blocker rather than modifying Auth configuration. Do not print or inspect session file contents in tool output.

The local page exits after a successful connection or ten minutes. Re-run sign-in for an expired session. Local sign-in uses port 8793 and fails rather than terminating another process using it. The tested official SDK version is 13.3.0. If an SDK update changes provider exchange behavior, verify account auto-creation stays disabled before updating. Use the printed URL; do not guess it. CUA sign-in handoff may require the user to finish Google authentication; wait for the visible Connected outcome and the script's success result before proceeding. No client/order writes occur during sign-in.

Run `node <skill>/scripts/firebase.mjs /absolute/path/request.json`. Request examples:

```json
{"environment":"dev","kind":"auth-check"}
```

```json
{"environment":"dev","kind":"query","operation":"GetClientByPhoneNumber","variables":{"phoneNumber":"+16476274814"}}
```

```json
{"environment":"dev","kind":"callable","operation":"getBookingAvailability","variables":{"day":"2026-11-29","offset":0}}
```

Every request needs an explicit environment. The helper prints data/actor metadata, never tokens. It requires an existing Google sign-in with Boolean Staff/Admin claims for `homerzhm@gmail.com`. If no session exists, ask for interactive sign-in setup and explain that live creation is blocked; the user may choose to finish the skill and set up authentication later. Do not ask the user to paste passwords or tokens into chat. Never alter roles or OAuth restrictions as part of slip processing.

Writes require `approved: true` **only after actual user approval**, and an absolute `journalPath` in a private persistent directory outside the repo (for example `~/.codex/mtl-order-slips/journals/<environment>/<uuid>.json`, subject to filesystem permissions). One journal per client mutation or order request. Supply `retryAuthorized: true` only after reconciliation and explicit approval to retry. If a crash leaves a `.lock`, inspect the journal and running process first; do not blindly delete locks. Request JSON files contain personal data but no credentials; protect them with mode 0600. Same-journal requests cannot run concurrently.

```json
{
  "environment":"dev", "kind":"mutation", "operation":"CreateClient",
  "approved":true, "journalPath":"/absolute/private/path/client-request.json",
  "variables":{"id":"<stable-client-uuid>","phoneNumber":"+16476274814","name":null,"email":null}
}
```

```json
{
  "environment":"dev", "kind":"callable", "operation":"createStaffOrder",
  "approved":true, "journalPath":"/absolute/private/path/order-request.json",
  "variables": {
    "id":"<stable-order-request-uuid>",
    "items":[{"id":"<stable-line-uuid>","productId":"<live-environment-product-uuid>","expectedRevision":0,"quantity":1}],
    "clientId":"<saved-client-uuid>", "contactPhoneNumber":"+16476274814",
    "scheduledFor":"2026-11-29T17:30:00.000Z",
    "expectedSettingsRevision":0,
    "expectedGroups":[{"id":"<live-group-uuid>","expectedRevision":0}],
    "allocations":[{"groupId":"<live-group-uuid>","blockMinute":660,"quantity":1}],
    "depositRequiredCents":0,"depositReceivedCents":10000,"notes":null
  }
}
```

These are **illustrative values**, not a ready-to-submit order. Replace every UUID and revision from fresh selected-environment reads; confirm date, items, amounts and allocations through the preview. UUIDs must use lowercase canonical hyphenated form; SQL Connect responses may return 32 hexadecimal characters, which must be normalized before callable submission. `scheduledFor` is a future UTC ISO timestamp with zero seconds and milliseconds, representing a Toronto quarter-hour. For ungrouped items, `expectedGroups` and `allocations` are empty arrays, while settings revision is still required. Price/discount overrides and backdating receipt timestamps are unsupported. Deposits cannot exceed the current subtotal. At most 100 distinct products; quantities 1–99.

## Read operations and pagination

Connector service `restaurant`, connector `staff-admin`. Queries return named GraphQL data objects. Pass each offset explicitly and continue until a page has fewer than 100 entries; deduplicate IDs. Availability uses its returned `nextOffset`, not assumed offsets, and string counts must be handled as BigInt. Configuration revisions changing between pages require a refresh.

| Operation | Variables | Purpose |
| --- | --- | --- |
| GetClientByPhoneNumber | phoneNumber | Exact canonical phone lookup |
| ListClientHistory | id (client UUID), offset | All orders linked to stable client ID; load GetOrder for pickup |
| GetOrdersByPhoneNumber | phoneNumber, offset | Phone snapshot orders, including missing/mismatched client links |
| ListProducts | offset | Live product IDs, names, CAD cents, revisions, activity and group links |
| GetProduct | id | Refresh matched product |
| GetOrder | id | Full order and financial summary |
| ListOrderItems | id (order UUID), offset | Saved products, quantity and price snapshots |
| ListOrderPayments | id, offset | Actual receipts and status |
| ListOrderRefunds | id, offset | Successful refunds affecting net paid |
| ListOrderCapacityAllocations | id, offset | Saved group blocks and quantities |
| ListOrderAuditEvents | id, offset | Audit verification/reconciliation |

Callable `getBookingAvailability({day, offset})` returns settings, blocks with group revisions and decimal-string capacity counts, and nextOffset. Callable `createStaffOrder(payload)` returns `{id}` for a future booking. Both require a verified Firebase Google Staff/Admin user. Historical mode uses the separate Admin-only `importHistoricalOrder` callable and the [historical workflow](historical.md). Do not invoke `updateStaffOrder` to silently correct mismatched slips.

## Protocol references

- [Callable protocol](https://firebase.google.com/docs/functions/callable-reference): POST `{data: payload}` with Firebase user `Authorization: Bearer` token; inspect callable errors even for JSON HTTP responses.
- [Google provider sign-in](https://cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithIdp): use a legitimate provider credential whose OAuth audience is accepted by the selected Firebase project. CLI OAuth tokens failed this check in initial Dev testing.
- [Execute connector query](https://firebase.google.com/docs/reference/sql-connect/rest/v1/projects.locations.services.connectors/executeQuery) and [mutation](https://firebase.google.com/docs/reference/sql-connect/rest/v1/projects.locations.services.connectors/executeMutation): use deployed operationName and variables, app API key, and `x-firebase-auth-token`. Never use `impersonate` or admin GraphQL execution to simulate an app user.

## Initial Dev read test

For the provided 70LB slip, the exact phone lookup and phone-order lookup returned no rows. Availability for November 29, 2026 showed an 11:00 Lechon block with 18 places remaining. Dev's current 70LB price was CAD $300 while the slip total was $320, so the workflow correctly stopped for price review before any client/order/receipt write. These are test observations, not fixtures; always read current data.
