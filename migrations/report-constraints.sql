BEGIN;

ALTER TABLE public.report_entry ADD CONSTRAINT report_entry_values_check CHECK (
  type IN ('creditEMT', 'totalCash', 'paybill', 'adjust', 'cashDepositPig',
    'creditEMTDepositPig', 'otherCost', 'weeklyPayroll')
  AND amount_cents > -2147483648 AND (amount_cents > 0 OR (type = 'adjust' AND amount_cents < 0))
  AND revision >= 0
);

ALTER TABLE public.report_entry_change ADD CONSTRAINT report_entry_change_values_check CHECK (
  revision >= 0 AND operation IN ('create', 'update', 'delete')
  AND (operation = 'create') = (revision = 0)
  AND payload_hash ~ '^[0-9a-f]{64}$'
);

COMMIT;
