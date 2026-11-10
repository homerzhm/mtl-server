-- Apply after additive OrderActionRequest schema, before enabling the native actions.
-- Existing legacy orders keep their connector behavior. Managed native orders enforce
-- the payment/status rules even when an older connector mutation is used.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.guard_native_order_status() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE net bigint; total integer;
BEGIN
  IF OLD.booking_managed AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status='PAID' THEN
      IF OLD.status<>'CONFIRMED' THEN RAISE EXCEPTION 'ORDER_LOCKED'; END IF;
      total := OLD.subtotal_cents-OLD.discount_cents;
      SELECT COALESCE((SELECT sum(amount_cents) FROM payment WHERE order_id=OLD.id AND status='SUCCEEDED'),0)
        -COALESCE((SELECT sum(r.amount_cents) FROM refund r JOIN payment p ON p.id=r.payment_id
          WHERE p.order_id=OLD.id AND r.status='SUCCEEDED'),0) INTO net;
      IF net<total THEN RAISE EXCEPTION 'ORDER_BALANCE_DUE'; END IF;
      IF NEW.final_total_cents IS DISTINCT FROM total THEN RAISE EXCEPTION 'ORDER_TOTAL_REVIEW'; END IF;
    ELSIF NEW.status='COMPLETED' AND OLD.status<>'PAID' THEN
      RAISE EXCEPTION 'ORDER_NOT_PAID';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_order_status_guard ON customer_order;
CREATE TRIGGER native_order_status_guard BEFORE UPDATE ON customer_order FOR EACH ROW EXECUTE FUNCTION public.guard_native_order_status();
CREATE OR REPLACE FUNCTION public.guard_native_payment() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parent customer_order;
BEGIN
  -- Same parent lock as callable/connector writes; serializes with Paid and pickup.
  SELECT * INTO parent FROM customer_order WHERE id=NEW.order_id FOR UPDATE;
  IF parent.booking_managed AND parent.status<>'CONFIRMED' THEN RAISE EXCEPTION 'ORDER_LOCKED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_payment_guard ON payment;
CREATE TRIGGER native_payment_guard BEFORE INSERT ON payment FOR EACH ROW EXECUTE FUNCTION public.guard_native_payment();
COMMIT;
