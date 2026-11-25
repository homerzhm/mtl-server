SELECT count(*)=2 AS ok
FROM information_schema.columns
WHERE table_schema='public' AND table_name='customer_order' AND is_nullable='YES'
  AND ((column_name='roast_block_needed_reason' AND data_type='text')
    OR (column_name='price_override_cents' AND data_type='integer'))
