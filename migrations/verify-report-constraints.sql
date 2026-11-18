SELECT count(*) = 2 AS ok
FROM pg_constraint
WHERE convalidated
  AND ((conrelid = 'public.report_entry'::regclass AND conname = 'report_entry_values_check')
    OR (conrelid = 'public.report_entry_change'::regclass AND conname = 'report_entry_change_values_check'))
