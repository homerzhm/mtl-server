-- Paid is a lifecycle status. Preserve the agreed total and leave the ledger alone.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.guard_native_order_status() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE total integer;
BEGIN
  IF OLD.booking_managed AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status='PAID' THEN
      IF OLD.status<>'CONFIRMED' THEN RAISE EXCEPTION 'ORDER_LOCKED'; END IF;
      total := COALESCE(OLD.final_total_cents, OLD.subtotal_cents-OLD.discount_cents);
      IF NEW.final_total_cents IS DISTINCT FROM total THEN RAISE EXCEPTION 'ORDER_TOTAL_REVIEW'; END IF;
    ELSIF NEW.status='COMPLETED' AND OLD.status<>'PAID' THEN
      RAISE EXCEPTION 'ORDER_NOT_PAID';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
