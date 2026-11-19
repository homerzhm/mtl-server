SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_trigger AS t
  JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.customer_order'::regclass
    AND t.tgname = 'historical_order_reopen_guard' AND t.tgenabled = 'O'
    AND p.oid = to_regprocedure('public.guard_historical_order_reopen()')
    AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
      WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    )
) AS ok;
