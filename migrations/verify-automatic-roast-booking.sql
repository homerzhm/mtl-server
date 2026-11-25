SELECT (
  SELECT count(*)=2 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='customer_order' AND is_nullable='YES'
    AND column_name IN ('roast_block_needed_reason','price_override_cents')
) AND EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid='public.customer_order'::regclass
    AND conname='customer_order_assignment_check' AND convalidated
) AND EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid='public.customer_order'::regclass
    AND tgname='order_capacity_assignment_change' AND tgdeferrable AND tginitdeferred
) AS ok
