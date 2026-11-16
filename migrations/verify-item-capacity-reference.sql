SELECT EXISTS(
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.order_item'::regclass AND conname='order_item_capacity_group_id_fkey'
    AND confrelid='public.capacity_group'::regclass AND contype='f'
    AND confdeltype='r' AND convalidated
) AS ok;
