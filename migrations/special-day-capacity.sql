-- Apply after the additive SpecialDayRule schema and all previous booking migrations.
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtextextended('booking-capacity',0));

CREATE OR REPLACE FUNCTION public.valid_special_day_keys(keys integer[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT array_ndims(keys)=1 AND cardinality(keys) BETWEEN 1 AND 366
    AND keys=ARRAY(SELECT DISTINCT key FROM unnest(keys) key ORDER BY key)
    AND NOT EXISTS(SELECT 1 FROM unnest(keys) key WHERE key IS NULL OR key NOT BETWEEN 101 AND 1231
      OR key%100 NOT BETWEEN 1 AND (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[key/100])
$$;

ALTER TABLE public.special_day_rule DROP CONSTRAINT IF EXISTS special_day_rule_values_valid;
ALTER TABLE public.special_day_rule ADD CONSTRAINT special_day_rule_values_valid
  CHECK (capacity_per_block>=0 AND revision>=0 AND saved_revision>0
    AND public.valid_special_day_keys(day_keys) IS TRUE);

DROP TRIGGER IF EXISTS booking_capacity_lock ON public.special_day_rule;
CREATE TRIGGER booking_capacity_lock BEFORE INSERT OR UPDATE OR DELETE ON public.special_day_rule
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_booking_capacity();

CREATE OR REPLACE FUNCTION public.special_day_capacity(target uuid, pickup_day date) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT r.capacity_per_block FROM public.special_day_rule r
  WHERE r.group_id=target AND (extract(month FROM pickup_day)::integer*100+extract(day FROM pickup_day)::integer)=ANY(r.day_keys)
  ORDER BY r.saved_revision DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.effective_block_capacity(target uuid, pickup_day date, usual_limit integer) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(public.special_day_capacity(target,pickup_day),usual_limit)
$$;

CREATE OR REPLACE FUNCTION public.guard_capacity_group() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ARCHIVE_GROUP_INSTEAD'; END IF;
  IF NEW.capacity_per_block<1 OR NEW.revision<0 OR NEW.code !~ '^[A-Z][A-Z0-9_]{0,63}$'
    OR btrim(NEW.name)='' OR NEW.name<>btrim(NEW.name) OR length(NEW.name)>200 THEN RAISE EXCEPTION 'BOOKING_CONFIGURATION_INVALID'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'BOOKING_CONFIGURATION_CONFLICT'; END IF;
    IF NEW.archived AND EXISTS(SELECT 1 FROM product WHERE capacity_group_id=NEW.id) THEN RAISE EXCEPTION 'GROUP_HAS_PRODUCTS'; END IF;
    IF NEW.capacity_per_block<OLD.capacity_per_block AND EXISTS(SELECT 1 FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
      WHERE a.group_id=NEW.id AND o.status<>'CANCELLED'
        AND a.pickup_day>=(clock_timestamp() AT TIME ZONE 'America/Toronto')::date
        AND public.special_day_capacity(NEW.id,a.pickup_day) IS NULL
      GROUP BY a.pickup_day,a.block_minute HAVING sum(a.quantity)>NEW.capacity_per_block) THEN RAISE EXCEPTION 'GROUP_CAPACITY_IN_USE'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.protect_managed_booking() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.native_order_edit_allowed(NEW.id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
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
      GROUP BY a.pickup_day,a.group_id,a.block_minute,g.capacity_per_block HAVING sum(a.quantity)>public.effective_block_capacity(a.group_id,a.pickup_day,g.capacity_per_block))
      THEN RAISE EXCEPTION 'GROUP_CAPACITY' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.guard_capacity_allocation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parent customer_order; limit_value integer; used bigint;
BEGIN
  IF public.native_order_edit_allowed(CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED'; END IF;
  SELECT * INTO parent FROM customer_order WHERE id=NEW.order_id;
  IF NOT parent.booking_managed OR NEW.pickup_day IS DISTINCT FROM (parent.scheduled_for AT TIME ZONE 'America/Toronto')::date
    OR NOT EXISTS(SELECT 1 FROM booking_settings WHERE id='default' AND NEW.block_minute=ANY(block_minutes))
    OR NOT EXISTS(SELECT 1 FROM order_item WHERE order_id=NEW.order_id AND capacity_group_id=NEW.group_id)
    THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
  SELECT public.effective_block_capacity(id,NEW.pickup_day,capacity_per_block) INTO limit_value FROM capacity_group WHERE id=NEW.group_id AND NOT archived;
  IF limit_value IS NULL THEN RAISE EXCEPTION 'GROUP_UNAVAILABLE'; END IF;
  SELECT COALESCE(sum(a.quantity),0) INTO used FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
    WHERE a.pickup_day=NEW.pickup_day AND a.group_id=NEW.group_id AND a.block_minute=NEW.block_minute AND o.status<>'CANCELLED';
  IF parent.status<>'CANCELLED' AND used+NEW.quantity>limit_value THEN RAISE EXCEPTION 'GROUP_CAPACITY'; END IF;
  RETURN NEW;
END $$;

COMMIT;
