SELECT EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgrelid='public.customer_order'::regclass
    AND tgname='native_order_status_guard'
    AND tgfoid='public.guard_native_order_status()'::regprocedure
    AND tgenabled='O'
)
AND position('COALESCE(OLD.final_total_cents' in pg_get_functiondef('public.guard_native_order_status()'::regprocedure))>0
AND position('ORDER_BALANCE_DUE' in pg_get_functiondef('public.guard_native_order_status()'::regprocedure))=0 AS ok;
