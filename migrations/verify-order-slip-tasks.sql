SELECT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid='public.order_slip_task'::regclass
    AND conname='order_slip_task_state_valid' AND contype='c' AND convalidated
) AS ok;
