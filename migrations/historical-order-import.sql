BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.guard_historical_order_reopen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.order_audit_event
    WHERE order_id = OLD.id AND order_revision = 0 AND action = 'ORDER_CREATED'
      AND changes ? 'historicalImport'
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_ORDER_CLOSED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_historical_order_reopen() FROM PUBLIC;

DROP TRIGGER IF EXISTS historical_order_reopen_guard ON public.customer_order;
CREATE TRIGGER historical_order_reopen_guard BEFORE UPDATE OF status ON public.customer_order
FOR EACH ROW WHEN (OLD.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.guard_historical_order_reopen();

COMMIT;
