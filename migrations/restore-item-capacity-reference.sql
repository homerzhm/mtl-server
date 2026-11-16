-- Restore the reviewed historical group reference without modifying any rows.
-- Some earlier compatible schema maintenance left this FK as SET NULL.
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtextextended('booking-capacity', 0));
DO $$
DECLARE delete_rule "char";
BEGIN
  SELECT confdeltype INTO delete_rule FROM pg_constraint
    WHERE conrelid='public.order_item'::regclass
      AND conname='order_item_capacity_group_id_fkey' AND contype='f';
  IF delete_rule IS NULL THEN
    RAISE EXCEPTION 'Expected order item capacity-group foreign key is missing';
  ELSIF delete_rule='n' THEN
    ALTER TABLE public.order_item DROP CONSTRAINT order_item_capacity_group_id_fkey;
    ALTER TABLE public.order_item ADD CONSTRAINT order_item_capacity_group_id_fkey
      FOREIGN KEY (capacity_group_id) REFERENCES public.capacity_group(id) ON DELETE RESTRICT;
  ELSIF delete_rule<>'r' THEN
    RAISE EXCEPTION 'Unexpected order item capacity-group delete rule: %',delete_rule;
  END IF;
END $$;
COMMIT;
