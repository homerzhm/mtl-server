# Batch image review and approval

Use for two or more images, including a ten-image upload. Apply the same extraction, confidence, database checks and app operations as a single slip. This is batch processing of missing clients/orders, not permission to patch existing orders.

## Prepare all entries

1. Establish one explicit environment for the batch. Assign stable review IDs in upload order (`01`, `02`, etc.), retaining each original filename, image-content hash, extracted fields and proposed action. IDs identify review entries, not slip numbers. Keep a private persistent batch manifest outside the repo, with a batch UUID, review revision, selected IDs, actor, client/order request files and journals. Never put tokens or image bytes in request journals.
2. Process every image and complete required selected-environment reads. Reuse catalog/configuration snapshots where consistent; page all reads. If a file is unreadable or unavailable, retain its entry and show the problem rather than dropping it. Use `ready`, `already-exists`, `duplicate-upload`, or `needs-clarification` as review statuses. Nothing is written yet.
3. Check duplicates both against Firebase and within the batch. Identical image hashes reference the first entry and propose no second write. Separate photographs of the same slip can have different hashes: group candidates by stable client ID or exact normalized phone plus pickup instant and compare items/money. Do not automatically merge, sum deposits, or create multiple same-time orders; flag matching or conflicting candidates for review unless they are clearly the same repeated upload. A client with different pickup instants can have multiple legitimate orders. Reuse one proposed client UUID per missing normalized phone across those orders.
4. Account for the whole batch's capacity: group selected new orders by pickup day, group and chosen block and sum demand, subtracting each proposed reservation from the preview's remaining capacity. Do not count excluded/existing/duplicate entries as new occupancy. If combined demand exceeds availability, flag all affected candidates and ask which should be included; never mark every order individually ready against the same unadjusted remaining count or silently select a winner. Preserve the agreed block-selection rule and ask before moving blocks.

## Show image and data side by side

Each entry needs its own image on the left and its extracted-data/confidence table on the right. Include filename and review ID prominently, environment, status, original versus proposed values, inference/source labels, catalog and duplicate-check evidence, pickup versus allocation, proposed client action, total, received cash, balance and unresolved questions. Make Medium/Low critical fields conspicuous. Do not replace the images with filenames or offer only an aggregate table. Do not put ten images across one row.

Use native in-chat paired images and tables if the surface supports that layout. Also generate a local, self-contained HTML review using `scripts/render-batch-review.mjs` when needed for reliable two-column presentation or a larger batch. It embeds local PNG/JPEG/WebP/GIF previews and needs no hosting or uploads. Convert HEIC originals to temporary PNG previews first; preserve filename/hash associations. Open the review locally when browser tools are available, or provide its clickable absolute file link. Use an output directory outside the repo for personal data and image previews. Verify every entry appears and each source image is paired with the correct data before presenting it. On narrow screens the two columns may stack; the pairing remains clear.

For each affected entry, put the cut extra callout above its extraction table. In the HTML display manifest, use `cutExtraRoastBlocks` with one text line per affected lechon item and block. Omit the field for entries where the rule does not apply.

The helper's JSON input is a **display manifest**, not an approved API payload:

```json
{
  "batchId":"<batch-uuid>", "revision":1, "environment":"dev",
  "actorEmail":"homerzhm@gmail.com",
  "summary":["10 images reviewed; 7 ready, 1 already exists, 1 duplicate upload, 1 needs clarification", "Proposed writes: 7 orders, 5 unique new clients; CAD $700 cash receipts", "Excluded entries: 03, 08, 10; no changes to existing orders"],
  "entries":[{
    "id":"01", "filename":"IMG_0042.HEIC", "imagePath":"/absolute/private/path/preview.png", "status":"ready",
    "fields":[
      {"field":"Phone", "value":"+1 647-627-4814", "confidence":"High", "source":"Read from image; normalized", "evidence":"Digits clearly legible"},
      {"field":"Pickup year", "value":"2026", "confidence":null, "source":"Inferred by rule", "evidence":"Year absent; next future occurrence; weekday agrees"}
    ],
    "cutExtraRoastBlocks":["1 × 70 LB lechon moves from 3:30 p.m. to 1:00 p.m. for a 4:00 p.m. Toronto pickup. The roast block must be at or before 3:00 p.m."],
    "checks":["No existing same-pickup order found", "Catalog: 1 × 70LB at CAD $320"],
    "actions":["Create client with blank name/email", "Create Confirmed order with CAD $100 already received cash; CAD $220 balance"],
    "questions":[]
  }]
}
```

The numbers above illustrate formatting only; calculate actual counts and sums from the selected batch manifest using integer cents. Run `node <skill>/scripts/render-batch-review.mjs /absolute/path/display.json /absolute/path/review.html`. The page deliberately has no write-capable confirmation button; final approval is requested in the agent chat after review.

## One final confirmation

After all pairs, show a summary with every entry ID/status, the exact ready IDs proposed for execution, IDs excluded and why, number of unique new clients, number of new orders, summed order totals and already received cash, environment/project/actor and batch review revision. Existing orders propose zero writes. Resolve critical ambiguities first; by default hold the whole batch while any remain. The user can explicitly exclude unresolved entries and approve the clearly listed ready subset; do not silently interpret “approve all” as permission to skip questions or accept guesses.

Ask one final question, for example: “Approve batch <ID>, revision 2, in Dev: create the 7 listed orders and 5 clients, recording CAD $700 already received cash? Entries 03, 08 and 10 are excluded as shown.” Do not ask for separate confirmation per ready image after that approval. If the user corrects or adds images, regenerate affected pairs, recompute deduplication/client/capacity/financial summaries, increment the review revision and seek approval of the revised set. Mere upload, review-page opening or a status label is not approval.

## Execute and reconcile

After approval, refresh duplicate/catalog/capacity checks for the whole selected set before the first write. If any plan value or duplicate status has changed, pause for review rather than silently changing the approved set. Serialize writes in the displayed order and use the existing per-request actor-bound UUID journals. Create shared clients only once and reuse their saved UUIDs. For each order invoke `createStaffOrder` with its deposit, then verify it before proceeding.

The batch is **not one database transaction**: clients and orders are saved separately and each order is atomic. If a write fails or becomes uncertain, stop subsequent batch writes, preserve completed results and all pending request identities, reconcile the affected request, and report each entry's state. Never claim the whole batch rolled back, delete successful orders to simulate rollback, or replay completed deposits. Resuming a previously attempted/uncertain batch requires reconciliation and explicit approval of remaining/retry actions; it does not create new identities for unresolved requests.

End with one result row per image (including excluded duplicates), saved order numbers for successes, confirmed deposit/balance, and failed/uncertain/unattempted entries. Retain a private batch-to-journal index for explicit resume after restart. Do not retain source images beyond the review workflow unnecessarily; do not commit any review artifacts or credentials.
