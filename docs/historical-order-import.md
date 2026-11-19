# Historical order import

`importHistoricalOrder` records one reviewed, completed pickup from a paper slip or an external system. It requires Firebase Google sign-in and a Boolean Admin claim. Imported orders are visible in the existing order and client history. Use `createStaffOrder` for new bookings.

## Callable payload

All prices and receipts are integer CAD cents. A successful call returns `{id}`.

```ts
{
  id: string                  // Stable order UUID
  items: {
    id: string                // Stable line UUID
    productId: string
    expectedRevision: number  // Revision from the approved catalog preview
    quantity: number          // 1–99
  }[]
  scheduledFor: string        // Exact past pickup instant as UTC ISO 8601
  createdAt?: string | null   // Original order time, defaults to scheduledFor
  clientId?: string | null    // Existing client, if linked
  contactPhoneNumber?: string | null
  notes?: string | null
  payments: {
    amountCents: number       // Positive signed Int32
    receivedAt?: string | null // Original receipt time, defaults to scheduledFor
  }[]
}
```

- Supply up to 100 distinct products and 100 receipts. Use an empty payment array for a reviewed zero-receipt order. Missing products fail the whole order with `PRODUCT_UNAVAILABLE`. Inactive products qualify. A changed revision returns `CATALOG_CHANGED` and requires a new review.
- Match the year, local time, and UTC instant in America/Toronto before submission. Creation and receipt timestamps can equal pickup or precede it. Invalid dates, future pickup, and later receipt times fail validation. Historical pickup accepts exact times within the minute or between live quarter-hour slots.
- The current catalog sets both subtotal and final total. Each supplied amount becomes a separate successful cash receipt. For a $300 slip with a $100 deposit and $200 remainder and a current catalog total of $320, the order shows $300 received and $20 owing.
- Paid and Completed occur at pickup. Creation and payment audits use the historical effective timestamps. Creation audit metadata records the actual import time, and the audit actor is the authenticated importer. The order has zero production allocations. Existing Admin cash corrections remain available on the Completed order.

## Review, retries, and rollout

- Apply payments inferred from the original slip total only after review. Check existing product, client and pickup matches before a write. Where a linked client is needed, create it with the normal client operation before calling the importer. The client and order calls are separate transactions.
- Keep the actor, project, stable UUIDs and exact approved request in the private journal. On an uncertain response, read the order by UUID and verify the items, receipts, Paid and Completed audits, and balance. Retry the same request only after reconciliation. The callable returns an existing result for the same actor and normalized payload, and returns `REQUEST_CONFLICT` when the UUID belongs to another request.
- The callable uses the existing Orders identity and grants. Install and verify `migrations/historical-order-import.sql` before deploying it. The standalone trigger prevents imported orders from leaving Completed. No schema or connector operation changes are needed for the import. Follow the managed release runbook for dev acceptance and production promotion.
