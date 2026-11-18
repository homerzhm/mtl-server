SELECT EXISTS (SELECT 1 FROM pg_trigger
         WHERE tgrelid='public.special_day_rule'::regclass AND tgname='booking_capacity_lock'
           AND tgenabled='O')
  AND EXISTS (SELECT 1 FROM pg_constraint
         WHERE conrelid='public.special_day_rule'::regclass AND conname='special_day_rule_values_valid'
           AND convalidated)
  AND public.effective_block_capacity('00000000-0000-0000-0000-000000000000', DATE '2032-02-29', 5)=5
  AND public.valid_special_day_keys(ARRAY[229])
  AND NOT public.valid_special_day_keys(ARRAY[230])
  AND position('effective_block_capacity' in pg_get_functiondef('public.guard_capacity_allocation()'::regprocedure))>0
  AND position('effective_block_capacity' in pg_get_functiondef('public.protect_managed_booking()'::regprocedure))>0
  AND position('special_day_capacity' in pg_get_functiondef('public.guard_capacity_group()'::regprocedure))>0 AS ok;
