SELECT position(
  'price_override_cents=override_cents' IN pg_get_functiondef(
    'public.apply_native_order_edit(uuid,integer,jsonb,jsonb,jsonb)'::regprocedure)
) > 0 AS ok;
