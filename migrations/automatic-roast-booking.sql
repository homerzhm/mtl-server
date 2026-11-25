-- Apply before the compatible connector and callable release.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.customer_order
  ADD COLUMN IF NOT EXISTS roast_block_needed_reason text,
  ADD COLUMN IF NOT EXISTS price_override_cents integer;
ALTER TABLE public.customer_order DROP CONSTRAINT IF EXISTS customer_order_assignment_check;
ALTER TABLE public.customer_order ADD CONSTRAINT customer_order_assignment_check CHECK (
  (roast_block_needed_reason IS NULL OR
     (booking_managed AND scheduled_for IS NOT NULL AND roast_block_needed_reason IN ('NO_BLOCK','BLOCK_STARTED','BLOCK_FULL')))
  AND (price_override_cents IS NULL OR (price_override_cents>=0 AND final_total_cents IS NOT DISTINCT FROM price_override_cents))
);

CREATE OR REPLACE FUNCTION public.check_order_capacity_totals() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='customer_order' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
  IF EXISTS(SELECT 1 FROM customer_order WHERE id=target AND roast_block_needed_reason IS NOT NULL) THEN
    IF EXISTS(SELECT 1 FROM order_capacity_allocation WHERE order_id=target)
      OR NOT EXISTS(SELECT 1 FROM order_item WHERE order_id=target AND capacity_group_id IS NOT NULL)
      THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
    RETURN NULL;
  END IF;
  IF EXISTS(SELECT 1 FROM customer_order WHERE id=target AND booking_managed) AND EXISTS(
    SELECT 1 FROM
      (SELECT capacity_group_id AS group_id,sum(quantity) AS quantity FROM order_item
        WHERE order_id=target AND capacity_group_id IS NOT NULL GROUP BY capacity_group_id) i
      FULL JOIN (SELECT group_id,sum(quantity) AS quantity FROM order_capacity_allocation WHERE order_id=target GROUP BY group_id) a USING(group_id)
      WHERE i.quantity IS DISTINCT FROM a.quantity
  ) THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS order_capacity_assignment_change ON public.customer_order;
CREATE CONSTRAINT TRIGGER order_capacity_assignment_change
  AFTER UPDATE OF roast_block_needed_reason ON public.customer_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.roast_block_needed_reason IS DISTINCT FROM NEW.roast_block_needed_reason)
  EXECUTE FUNCTION public.check_order_capacity_totals();

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
  IF header->>'roast_block_needed_reason' IS NULL AND EXISTS(SELECT 1 FROM (
    SELECT v->>'capacity_group_id' id,sum((v->>'quantity')::bigint) n FROM jsonb_array_elements(lines) v
      WHERE v->>'capacity_group_id' IS NOT NULL GROUP BY 1) i
    FULL JOIN (SELECT v->>'groupId' id,sum((v->>'quantity')::bigint) n FROM jsonb_array_elements(allocations) v GROUP BY 1) a USING(id)
    WHERE i.n IS DISTINCT FROM a.n) THEN RAISE EXCEPTION 'GROUP_ALLOCATION_INVALID'; END IF;
  INSERT INTO public.native_order_edit_context VALUES(pg_backend_pid(),txid_current(),target);
  UPDATE public.customer_order SET revision=revision+1,updated_at=now(),
    scheduled_for=(header->>'scheduled_for')::timestamptz,client_id=(header->>'client_id')::uuid,
    contact_phone_number=header->>'contact_phone_number',notes=header->>'notes',
    subtotal_cents=(header->>'subtotal_cents')::integer,item_count=jsonb_array_length(lines),
    roast_block_needed_reason=header->>'roast_block_needed_reason',
    final_total_cents=COALESCE(parent.price_override_cents,(header->>'final_total_cents')::integer),status=header->>'status',booking_managed=true WHERE id=target;
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
COMMIT;
