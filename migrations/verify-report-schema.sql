SELECT to_regclass('public.report_entry') IS NOT NULL
  AND to_regclass('public.report_entry_change') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.report_entry'::regclass
    AND attname = 'day' AND atttypid = 'date'::regtype AND attnotnull)
  AND EXISTS (SELECT 1 FROM pg_index WHERE indrelid = 'public.report_entry_change'::regclass
    AND indisunique AND indisvalid AND pg_get_indexdef(indexrelid) LIKE '%(entry_id, revision)') AS ok
