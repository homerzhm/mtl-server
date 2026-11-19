# Import completed paper slips

Use this mode when the user requests historical import of completed pickups. Select Dev or Production first, then run the Firebase helper with `{"environment":"dev","kind":"auth-check","mode":"historical"}` (use the selected environment). A Google Admin session is required before any client or order write. Follow the standard extraction, client matching, duplicate checks, paired image review, batch approval and journaling rules in the main skill and [batch review](batch-review.md). Use the mode-specific steps below for time, catalog, payments and order submission.

## Prepare a historical review

1. Require an explicit historical pickup year and a reviewed Toronto pickup time. Convert it to UTC with a DST-aware round trip. Ask about unclear, ambiguous or nonexistent times and conflicting weekdays. Preserve the exact time, including off-quarter-hour pickups. When the slip gives an earlier order date or payment date, preserve its reviewed time. Ask for a time when only that earlier date is known. Use pickup as the fallback when an original date is absent.
2. Page the catalog and resolve all products by exact identity and size, including inactive rows. Use today's stored prices and revisions. Show written prices as source evidence, and show the current subtotal and final total separately. If a line has no matching product, mark the entire slip `missing-product` and exclude it from all client and order writes. Hold ambiguous matches for review. The current capacity group and available production blocks are irrelevant to historical import.
3. Preserve explicit reviewed payments as separate cash receipts. For a completed slip with a known original total and deposit, propose the original total minus deposit when the remainder is absent. If only the original total is known, propose one cash receipt for that amount. When separate documented amounts conflict with the original total, or the amounts are otherwise unclear, hold for review. Never derive a receipt from today's menu price. Omit zero-value receipts, using an empty list only for an explicitly reviewed zero-receipt order.
4. Run exact phone and linked client lookup, plus pickup duplicate checks, across the environment and batch. Compare the final status, item snapshots, separate receipts and pickup with any order already saved. Hold mismatches for review, including existing active or cancelled orders.
5. Show each slip beside its data and confidence. Include original total, current total, each proposed receipt and timestamp, resulting balance, proposed Completed status and the Paid and Completed pickup timestamp. Label inferred amounts and fallback times. Identify any skipped slips in the final action summary. Get one approval for the precise reviewed batch before writing.

## Submit and verify

Refresh catalog and duplicate checks for the approved subset before the first write. After all checks pass, reuse the standard approved client creation path if required. Call `importHistoricalOrder` once per slip with stable order and line UUIDs, current reviewed revisions, the exact pickup instant and approved cash receipts. Omit booking settings, groups and allocations. Persist each approved payload before submitting. The backend contract is in the server's `docs/historical-order-import.md`.

```json
{
  "environment": "dev",
  "kind": "callable",
  "operation": "importHistoricalOrder",
  "approved": true,
  "journalPath": "/absolute/private/path/historical-order-request.json",
  "variables": {
    "id": "<stable-order-uuid>",
    "items": [
      {"id": "<stable-line-uuid>", "productId": "<catalog-product-uuid>", "expectedRevision": 2, "quantity": 1}
    ],
    "clientId": "<saved-client-uuid>",
    "contactPhoneNumber": "+16476274814",
    "scheduledFor": "2026-11-01T17:37:00.000Z",
    "payments": [{"amountCents": 10000}, {"amountCents": 20000}],
    "notes": null
  }
}
```

Use actual reviewed data in every request. Each payment can specify its original `receivedAt`. The order can specify its original `createdAt`. Missing times use the approved pickup instant. The example produces a $20 balance if the current catalog total is $320.

Read back the order, items, receipts, financial summary, audits and allocations. Verify Completed, original or fallback event times, the Paid and Completed pickup timestamp, current catalog prices, each intended cash receipt, the balance and empty allocations. Retry an uncertain result only after reading by the stable UUID and getting explicit approval for the identical request. If a definitive catalog or product rejection is followed by a revised approval, verify that the original order is absent, retain the rejected journal and submit the newly approved payload with the same order UUID and a new journal path. Report one result per slip.
