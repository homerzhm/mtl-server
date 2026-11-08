-- Existing databases: broaden the order CHECK to accept manually marked PAID.
-- Apply before deploying MarkOrderPaid via a connector-only release. No schema
-- deployment is needed: status is already text. Keep all other protections.
-- The initial integrity migration does not replace an existing CHECK, so this
-- explicit follow-up is required. No rows are deleted or rewritten.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.customer_order
  DROP CONSTRAINT customer_order_values_check,
  ADD CONSTRAINT customer_order_values_check CHECK (
  subtotal_cents >= 0 AND item_count > 0 AND discount_cents BETWEEN 0 AND subtotal_cents
        AND deposit_required_cents >= 0 AND final_total_cents >= 0
        AND cancellation_total_cents >= 0 AND revision >= 0
        AND fulfillment_type = 'PICKUP' AND status IN ('CONFIRMED','PAID','COMPLETED','CANCELLED')
        AND order_number ~ '^[2-9A-HJKMNP-Z]{6}$'
        AND (contact_phone_number IS NULL OR contact_phone_number ~ '^\+[1-9][0-9]{1,14}$')
        AND ((status IN ('CONFIRMED','PAID') AND completed_at IS NULL AND cancelled_at IS NULL AND cancellation_total_cents IS NULL)
          OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND cancellation_total_cents IS NULL)
          OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancellation_total_cents IS NOT NULL))
  );
COMMIT;
