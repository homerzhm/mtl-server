-- Development schema replacement: apply AFTER the matching GraphQL schema.
-- Does not drop/reset existing data. Review incompatible schema removals separately.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.lock_order_creation_sources(product_ids uuid[], client_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.product WHERE id=ANY(product_ids) ORDER BY id FOR SHARE;
  IF client_id IS NOT NULL THEN
    PERFORM 1 FROM public.client WHERE id=client_id FOR SHARE;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.lock_order_creation_sources(uuid[],uuid) FROM PUBLIC;

-- One common gate, acquired before row locks by every relevant SQL writer.
CREATE OR REPLACE FUNCTION public.lock_booking_capacity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('booking-capacity',0));
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['booking_settings','capacity_group','product','customer_order','order_item','order_capacity_allocation'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS booking_capacity_lock ON %I',t);
    EXECUTE format('CREATE TRIGGER booking_capacity_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION public.lock_booking_capacity()',t);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.guard_booking_settings() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BOOKING_SETTINGS_REQUIRED'; END IF;
  IF NEW.id<>'default' OR cardinality(NEW.block_minutes)=0 OR cardinality(NEW.block_minutes)>96
    OR array_ndims(NEW.block_minutes)<>1
    OR EXISTS(SELECT 1 FROM unnest(NEW.block_minutes) m WHERE m IS NULL OR m<0 OR m>1439 OR m%15<>0)
    OR (SELECT count(DISTINCT m) FROM unnest(NEW.block_minutes) m)<>cardinality(NEW.block_minutes)
    OR NEW.revision<0 THEN RAISE EXCEPTION 'BOOKING_CONFIGURATION_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'BOOKING_CONFIGURATION_CONFLICT'; END IF;
    IF EXISTS(SELECT 1 FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
      WHERE o.status<>'CANCELLED' AND a.pickup_day>=(clock_timestamp() AT TIME ZONE 'America/Toronto')::date
        AND NOT(a.block_minute=ANY(NEW.block_minutes))) THEN RAISE EXCEPTION 'BOOKING_BLOCK_IN_USE'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS booking_settings_guard ON booking_settings;
CREATE TRIGGER booking_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON booking_settings FOR EACH ROW EXECUTE FUNCTION public.guard_booking_settings();
CREATE OR REPLACE FUNCTION public.guard_capacity_group() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ARCHIVE_GROUP_INSTEAD'; END IF;
  IF NEW.capacity_per_block<1 OR NEW.revision<0 OR NEW.code !~ '^[A-Z][A-Z0-9_]{0,63}$'
    OR btrim(NEW.name)='' OR NEW.name<>btrim(NEW.name) OR length(NEW.name)>200 THEN RAISE EXCEPTION 'BOOKING_CONFIGURATION_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'BOOKING_CONFIGURATION_CONFLICT'; END IF;
    IF NEW.archived AND EXISTS(SELECT 1 FROM product WHERE capacity_group_id=NEW.id) THEN RAISE EXCEPTION 'GROUP_HAS_PRODUCTS'; END IF;
    IF EXISTS(SELECT 1 FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
      WHERE a.group_id=NEW.id AND o.status<>'CANCELLED'
        AND a.pickup_day>=(clock_timestamp() AT TIME ZONE 'America/Toronto')::date
      GROUP BY a.pickup_day,a.block_minute HAVING sum(a.quantity)>NEW.capacity_per_block) THEN RAISE EXCEPTION 'GROUP_CAPACITY_IN_USE'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capacity_group_guard ON capacity_group;
CREATE TRIGGER capacity_group_guard BEFORE INSERT OR UPDATE OR DELETE ON capacity_group FOR EACH ROW EXECUTE FUNCTION public.guard_capacity_group();
CREATE OR REPLACE FUNCTION public.guard_product_capacity_group() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.capacity_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM capacity_group WHERE id=NEW.capacity_group_id AND NOT archived)
    THEN RAISE EXCEPTION 'GROUP_UNAVAILABLE'; END IF;
  IF TG_OP='UPDATE' AND NEW.capacity_group_id IS DISTINCT FROM OLD.capacity_group_id AND NEW.revision<>OLD.revision+1
    THEN RAISE EXCEPTION 'PRODUCT_CONFLICT'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS product_capacity_group_guard ON product;
CREATE TRIGGER product_capacity_group_guard BEFORE INSERT OR UPDATE ON product FOR EACH ROW EXECUTE FUNCTION public.guard_product_capacity_group();
ALTER TABLE order_capacity_allocation DROP CONSTRAINT IF EXISTS capacity_values_check;
ALTER TABLE order_capacity_allocation ADD CONSTRAINT capacity_values_check CHECK(block_minute BETWEEN 0 AND 1439 AND block_minute%15=0 AND quantity>0);
CREATE OR REPLACE FUNCTION public.protect_managed_booking() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT OLD.booking_managed AND NEW.status IN ('CONFIRMED','PAID') AND NEW.status IS DISTINCT FROM OLD.status
    AND EXISTS(SELECT 1 FROM order_item i JOIN product p ON p.id=i.product_id WHERE i.order_id=OLD.id
      AND (i.capacity_group_id IS NOT NULL OR p.capacity_group_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_REOPEN_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF OLD.booking_managed AND (NEW.booking_managed IS DISTINCT FROM OLD.booking_managed OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF OLD.booking_managed AND OLD.status='CANCELLED' AND NEW.status<>'CANCELLED' THEN
    IF EXISTS(SELECT 1 FROM order_capacity_allocation a WHERE a.order_id=OLD.id
      AND NOT EXISTS(SELECT 1 FROM booking_settings s WHERE s.id='default' AND a.block_minute=ANY(s.block_minutes)))
      THEN RAISE EXCEPTION 'BOOKING_BLOCK_UNAVAILABLE' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
      JOIN capacity_group g ON g.id=a.group_id
      WHERE (o.status<>'CANCELLED' OR o.id=OLD.id)
        AND EXISTS(SELECT 1 FROM order_capacity_allocation own WHERE own.order_id=OLD.id
          AND own.pickup_day=a.pickup_day AND own.group_id=a.group_id AND own.block_minute=a.block_minute)
      GROUP BY a.pickup_day,a.group_id,a.block_minute,g.capacity_per_block HAVING sum(a.quantity)>g.capacity_per_block)
      THEN RAISE EXCEPTION 'GROUP_CAPACITY' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_booking_guard ON customer_order;
CREATE TRIGGER managed_booking_guard BEFORE UPDATE ON customer_order FOR EACH ROW EXECUTE FUNCTION public.protect_managed_booking();
CREATE OR REPLACE FUNCTION public.protect_managed_items() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM customer_order WHERE id=OLD.order_id AND booking_managed)
    OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM customer_order WHERE id=NEW.order_id AND booking_managed))
    THEN RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_item_guard ON order_item;
CREATE TRIGGER managed_item_guard BEFORE UPDATE OR DELETE ON order_item FOR EACH ROW EXECUTE FUNCTION public.protect_managed_items();
CREATE OR REPLACE FUNCTION public.protect_managed_item_totals() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.booking_managed AND (NEW.item_count<>OLD.item_count OR NEW.subtotal_cents<>OLD.subtotal_cents) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS managed_item_totals_guard ON customer_order;
CREATE TRIGGER managed_item_totals_guard BEFORE UPDATE ON customer_order FOR EACH ROW EXECUTE FUNCTION public.protect_managed_item_totals();
CREATE OR REPLACE FUNCTION public.reject_unallocated_group() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM customer_order o JOIN product p ON p.id=NEW.product_id
    WHERE o.id=NEW.order_id AND NOT o.booking_managed AND o.status IN ('CONFIRMED','PAID') AND p.capacity_group_id IS NOT NULL)
    THEN RAISE EXCEPTION 'ALLOCATION_AWARE_CREATE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS legacy_lechon_creation_guard ON order_item;
DROP TRIGGER IF EXISTS legacy_group_creation_guard ON order_item;
CREATE TRIGGER legacy_group_creation_guard BEFORE INSERT ON order_item FOR EACH ROW EXECUTE FUNCTION public.reject_unallocated_group();
-- Allocations are immutable history. Only cancellation releases occupancy.
CREATE OR REPLACE FUNCTION public.guard_capacity_allocation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parent customer_order; limit_value integer; used bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED'; END IF;
  SELECT * INTO parent FROM customer_order WHERE id=NEW.order_id;
  IF NOT parent.booking_managed OR NEW.pickup_day IS DISTINCT FROM (parent.scheduled_for AT TIME ZONE 'America/Toronto')::date
    OR NOT EXISTS(SELECT 1 FROM booking_settings WHERE id='default' AND NEW.block_minute=ANY(block_minutes))
    OR NOT EXISTS(SELECT 1 FROM order_item WHERE order_id=NEW.order_id AND capacity_group_id=NEW.group_id)
    THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
  SELECT capacity_per_block INTO limit_value FROM capacity_group WHERE id=NEW.group_id AND NOT archived;
  IF limit_value IS NULL THEN RAISE EXCEPTION 'GROUP_UNAVAILABLE'; END IF;
  SELECT COALESCE(sum(a.quantity),0) INTO used FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
    WHERE a.pickup_day=NEW.pickup_day AND a.group_id=NEW.group_id AND a.block_minute=NEW.block_minute AND o.status<>'CANCELLED';
  IF parent.status<>'CANCELLED' AND used+NEW.quantity>limit_value THEN RAISE EXCEPTION 'GROUP_CAPACITY'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capacity_allocation_guard ON order_capacity_allocation;
CREATE TRIGGER capacity_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON order_capacity_allocation FOR EACH ROW EXECUTE FUNCTION public.guard_capacity_allocation();
-- Validate totals at commit, after the callable has inserted all items/allocations.
CREATE OR REPLACE FUNCTION public.check_order_capacity_totals() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='customer_order' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
  IF EXISTS(SELECT 1 FROM customer_order WHERE id=target AND booking_managed) AND EXISTS(
    SELECT 1 FROM
      (SELECT capacity_group_id AS group_id,sum(quantity) AS quantity FROM order_item
        WHERE order_id=target AND capacity_group_id IS NOT NULL GROUP BY capacity_group_id) i
      FULL JOIN (SELECT group_id,sum(quantity) AS quantity FROM order_capacity_allocation WHERE order_id=target GROUP BY group_id) a USING(group_id)
      WHERE i.quantity IS DISTINCT FROM a.quantity
  ) THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_order','order_item','order_capacity_allocation'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS order_capacity_totals ON %I',t);
    EXECUTE format('CREATE CONSTRAINT TRIGGER order_capacity_totals AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_order_capacity_totals()',t);
  END LOOP;
END $$;
-- Bootstrap the shared schedule only; preserve administrator edits on reruns.
INSERT INTO booking_settings(id,block_minutes,revision,updated_at,updated_by)
  VALUES('default',ARRAY[660,780,930,1080],0,now(),'bootstrap') ON CONFLICT DO NOTHING;
-- Capacity groups are created explicitly through manageBookingConfiguration.
COMMIT;
