SELECT to_regclass('public.order_slip_task') IS NOT NULL
  AND to_regclass('public."order_slip_task_createdAt_id_idx"') IS NOT NULL
  AND to_regclass('public."order_slip_task_status_availableAt_idx"') IS NOT NULL
  AND to_regclass('public."order_slip_task_expiresAt_idx"') IS NOT NULL AS ok;
