-- Apply after order-actions.sql, before deploying PAYMENT_EDIT support.
-- No schema/table changes. Grant UPDATE(amount_cents,status) ON payment to the
-- selected ORDERS runtime role separately; see docs/live-order-booking.md.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.guard_payment_correction_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.method IS DISTINCT FROM OLD.method OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'PAYMENT_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payment_correction_identity_guard ON payment;
CREATE TRIGGER payment_correction_identity_guard BEFORE UPDATE ON payment
FOR EACH ROW EXECUTE FUNCTION public.guard_payment_correction_identity();
COMMIT;
