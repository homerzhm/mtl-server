-- Apply after additive NativeOrderEditContext schema and payment-edits.sql.
-- No cloud operation is performed by this file.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS public.native_order_edit_context (
  backend_pid integer NOT NULL, transaction_id bigint NOT NULL, order_id uuid NOT NULL,
  PRIMARY KEY(backend_pid,transaction_id,order_id)
);
REVOKE ALL ON public.native_order_edit_context FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.native_order_edit_allowed(target uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS(SELECT 1 FROM public.native_order_edit_context
    WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND order_id=target)
$$;
-- This read-only predicate cannot create a privileged context.
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
      GROUP BY a.pickup_day,a.group_id,a.block_minute,g.capacity_per_block HAVING sum(a.quantity)>g.capacity_per_block)
      THEN RAISE EXCEPTION 'GROUP_CAPACITY' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.protect_managed_items() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.native_order_edit_allowed(CASE WHEN TG_OP='DELETE' THEN OLD.order_id ELSE NEW.order_id END) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM customer_order WHERE id=OLD.order_id AND booking_managed)
    OR (TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM customer_order WHERE id=NEW.order_id AND booking_managed))
    THEN RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.protect_managed_item_totals() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.native_order_edit_allowed(NEW.id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF OLD.booking_managed AND (NEW.item_count<>OLD.item_count OR NEW.subtotal_cents<>OLD.subtotal_cents) THEN
    RAISE EXCEPTION 'ALLOCATION_AWARE_EDIT_REQUIRED' USING ERRCODE='23514'; END IF;
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
  SELECT capacity_per_block INTO limit_value FROM capacity_group WHERE id=NEW.group_id AND NOT archived;
  IF limit_value IS NULL THEN RAISE EXCEPTION 'GROUP_UNAVAILABLE'; END IF;
  SELECT COALESCE(sum(a.quantity),0) INTO used FROM order_capacity_allocation a JOIN customer_order o ON o.id=a.order_id
    WHERE a.pickup_day=NEW.pickup_day AND a.group_id=NEW.group_id AND a.block_minute=NEW.block_minute AND o.status<>'CANCELLED';
  IF parent.status<>'CANCELLED' AND used+NEW.quantity>limit_value THEN RAISE EXCEPTION 'GROUP_CAPACITY'; END IF;
  RETURN NEW;
END $$;

-- Only the Orders runtime gets EXECUTE, never context-table access or broad item/allocation DML.
-- Inputs are server-validated snapshots. Recheck active status/revision and exact totals here.
CREATE OR REPLACE FUNCTION public.apply_native_order_edit(target uuid, expected_revision integer,
  header jsonb, lines jsonb, allocations jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE parent public.customer_order; line jsonb; allocation jsonb; total bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('booking-capacity',0));
  SELECT * INTO parent FROM public.customer_order WHERE id=target FOR UPDATE;
  IF parent.id IS NULL OR parent.revision<>expected_revision THEN RAISE EXCEPTION 'ORDER_CONFLICT'; END IF;
  IF parent.status NOT IN ('CONFIRMED','PAID') THEN RAISE EXCEPTION 'ORDER_LOCKED'; END IF;
  SELECT sum((v->>'quantity')::bigint*(v->>'unit_price_cents')::bigint) INTO total FROM jsonb_array_elements(lines) v;
  IF jsonb_array_length(lines)=0 OR total IS DISTINCT FROM (header->>'subtotal_cents')::bigint
    OR total<parent.discount_cents OR total>2147483647 THEN RAISE EXCEPTION 'ORDER_EDIT_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM (
    SELECT v->>'capacity_group_id' id,sum((v->>'quantity')::bigint) n FROM jsonb_array_elements(lines) v
      WHERE v->>'capacity_group_id' IS NOT NULL GROUP BY 1) i
    FULL JOIN (SELECT v->>'groupId' id,sum((v->>'quantity')::bigint) n FROM jsonb_array_elements(allocations) v GROUP BY 1) a USING(id)
    WHERE i.n IS DISTINCT FROM a.n) THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
  INSERT INTO public.native_order_edit_context VALUES(pg_backend_pid(),txid_current(),target);
  UPDATE public.customer_order SET revision=revision+1,updated_at=now(),
    scheduled_for=(header->>'scheduled_for')::timestamptz,client_id=(header->>'client_id')::uuid,
    contact_phone_number=header->>'contact_phone_number',notes=header->>'notes',
    subtotal_cents=(header->>'subtotal_cents')::integer,item_count=jsonb_array_length(lines),
    final_total_cents=(header->>'final_total_cents')::integer,status=header->>'status',booking_managed=true WHERE id=target;
  DELETE FROM public.order_capacity_allocation WHERE order_id=target;
  DELETE FROM public.order_item WHERE order_id=target AND id NOT IN (SELECT (v->>'id')::uuid FROM jsonb_array_elements(lines) v);
  FOR line IN SELECT * FROM jsonb_array_elements(lines) LOOP
    IF EXISTS(SELECT 1 FROM public.order_item WHERE id=(line->>'id')::uuid AND order_id=target) THEN
      UPDATE public.order_item SET quantity=(line->>'quantity')::integer WHERE id=(line->>'id')::uuid AND order_id=target;
    ELSE
      INSERT INTO public.order_item(id,order_id,product_id,product_name,catalog_unit_price_cents,unit_price_cents,quantity,
        capacity_group_id,capacity_group_name_snapshot,notes,created_at)
        VALUES((line->>'id')::uuid,target,(line->>'product_id')::uuid,line->>'product_name',
          (line->>'catalog_unit_price_cents')::integer,(line->>'unit_price_cents')::integer,(line->>'quantity')::integer,
          (line->>'capacity_group_id')::uuid,line->>'capacity_group_name_snapshot',line->>'notes',now());
    END IF;
  END LOOP;
  FOR allocation IN SELECT * FROM jsonb_array_elements(allocations) LOOP
    INSERT INTO public.order_capacity_allocation(id,order_id,pickup_day,group_id,block_minute,quantity)
      VALUES(gen_random_uuid(),target,((header->>'scheduled_for')::timestamptz AT TIME ZONE 'America/Toronto')::date,
        (allocation->>'groupId')::uuid,(allocation->>'blockMinute')::integer,(allocation->>'quantity')::integer);
  END LOOP;
  IF (SELECT sum(quantity::bigint*unit_price_cents) FROM public.order_item WHERE order_id=target) IS DISTINCT FROM total
    OR (SELECT count(*) FROM public.order_item WHERE order_id=target)<>jsonb_array_length(lines) THEN
    RAISE EXCEPTION 'ORDER_EDIT_INVALID';
  END IF;
  DELETE FROM public.native_order_edit_context WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND order_id=target;
END $$;
REVOKE ALL ON FUNCTION public.apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb) FROM PUBLIC;
-- Cloud SQL Connect's owner defaults may grant new tables/routines to its
-- reader/writer roles. PUBLIC revocation alone does not remove those grants.
DO $$
DECLARE connector_role text;
BEGIN
  FOR connector_role IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('firebasereader_restaurant_public','firebasewriter_restaurant_public') LOOP
    EXECUTE format('REVOKE ALL ON public.native_order_edit_context FROM %I',connector_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb) FROM %I',connector_role);
  END LOOP;
END $$;
COMMIT;
