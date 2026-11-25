# Admin sell price changes on active orders

This extends the native order edit described in
[live order booking](live-order-booking.md). That document is the checksummed
procedure for applied migration 017, so it must not be edited; later order-edit
changes are documented here.

EDIT may include `priceOverride: {amountCents: number | null}`. The amount
sets the explicit sell price in exact nonnegative Int32 CAD cents. Null removes
the override and returns the sell price to subtotal less the saved discount.
Omit the field to keep the current override. Requests that omit the field keep
their legacy canonical hash. Setting or removing an override requires the
Google caller's Boolean Admin claim. Already committed requests reconcile by
actor and payload before permission and revision checks for a new write.

Review shows the projected total, balance or refund due, and status. The edit
does not move money. If a Paid order owes money after the edit, it returns to
Confirmed. The edit records the old and new override and totals in Activity.

Apply `migrations/order-edit-price-override.sql` (release migration
`019-order-edit-price-override`) before releasing the updated
`updateStaffOrder` callable, then distribute the iOS app. The migration replaces
the existing restricted edit routine and uses the current columns and grants.
