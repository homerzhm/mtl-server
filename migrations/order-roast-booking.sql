-- Apply AFTER the additive GraphQL schema, preserving existing integrity triggers.
-- Trusted callable inserts all rows atomically. Other writers cannot change a managed booking.
BEGIN;
-- Only lock the requested sources; callers retain SELECT-only table access.
-- Pin the search path and qualify tables because this runs with its owner's rights.
CREATE OR REPLACE FUNCTION public.lock_order_creation_sources(product_ids uuid[], client_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.product WHERE id=ANY(product_ids) ORDER BY id FOR SHARE;
  IF client_id IS NOT NULL THEN
    PERFORM 1 FROM public.client WHERE id=client_id FOR SHARE;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.lock_order_creation_sources(uuid[],uuid) FROM PUBLIC;
ALTER TABLE order_roast_allocation DROP CONSTRAINT IF EXISTS roast_values_check;
ALTER TABLE order_roast_allocation ADD CONSTRAINT roast_values_check CHECK(block_minute IN (660,780,930,1080) AND pigs BETWEEN 1 AND 18);
CREATE OR REPLACE FUNCTION protect_managed_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE day date; used integer;
BEGIN
  IF NOT OLD.booking_managed AND NEW.status IN ('CONFIRMED','PAID')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND EXISTS(SELECT 1 FROM order_item i JOIN product p ON p.id=i.product_id
       WHERE i.order_id=OLD.id AND COALESCE(i.is_lechon_snapshot,p.is_lechon)) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_REOPEN_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF OLD.booking_managed AND (NEW.booking_managed IS DISTINCT FROM OLD.booking_managed OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF OLD.booking_managed AND NEW.status IS DISTINCT FROM OLD.status THEN
    FOR day IN SELECT DISTINCT pickup_day FROM order_roast_allocation WHERE order_id=OLD.id ORDER BY pickup_day LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('roast:' || day::text,0));
      IF OLD.status='CANCELLED' AND NEW.status<>'CANCELLED' THEN
        SELECT max(n) INTO used FROM (
          SELECT sum(a.pigs)::int AS n FROM order_roast_allocation a JOIN customer_order o ON o.id=a.order_id
          WHERE a.pickup_day=day AND (o.status<>'CANCELLED' OR o.id=OLD.id) GROUP BY a.block_minute
        ) s;
        IF used>18 THEN RAISE EXCEPTION 'ROAST_CAPACITY' USING ERRCODE='23514'; END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_booking_guard ON customer_order;
CREATE TRIGGER managed_booking_guard BEFORE UPDATE ON customer_order FOR EACH ROW EXECUTE FUNCTION protect_managed_booking();
CREATE OR REPLACE FUNCTION protect_managed_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE managed boolean;
BEGIN
  SELECT booking_managed INTO managed FROM customer_order WHERE id=OLD.order_id;
  IF managed THEN RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_item_guard ON order_item;
CREATE TRIGGER managed_item_guard BEFORE UPDATE OR DELETE ON order_item FOR EACH ROW EXECUTE FUNCTION protect_managed_items();
-- AddOrderItem writes the parent count/subtotal before inserting a row. Guard that path,
-- including add-on-only managed orders that have no allocation rows.
CREATE OR REPLACE FUNCTION protect_managed_item_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.booking_managed AND (NEW.item_count<>OLD.item_count OR NEW.subtotal_cents<>OLD.subtotal_cents) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_item_totals_guard ON customer_order;
CREATE TRIGGER managed_item_totals_guard BEFORE UPDATE ON customer_order FOR EACH ROW EXECUTE FUNCTION protect_managed_item_totals();
-- Older one-item creation must not create unallocated lechon orders.
CREATE OR REPLACE FUNCTION reject_unallocated_lechon() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM customer_order o JOIN product p ON p.id=NEW.product_id
       WHERE o.id=NEW.order_id AND NOT o.booking_managed AND o.status IN ('CONFIRMED','PAID') AND p.is_lechon) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_CREATE_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS legacy_lechon_creation_guard ON order_item;
CREATE TRIGGER legacy_lechon_creation_guard BEFORE INSERT ON order_item FOR EACH ROW EXECUTE FUNCTION reject_unallocated_lechon();
COMMIT;
