BEGIN;
ALTER TABLE public.order_slip_task
  DROP CONSTRAINT order_slip_task_state_valid,
  ADD CONSTRAINT order_slip_task_state_valid CHECK (
    status IN ('QUEUED','PROCESSING','READY','FAILED')
    AND provider IN ('vertex','openai','deepseek')
    AND attempts BETWEEN 0 AND 3 AND dispatch_generation > 0
    AND ((status = 'READY' AND preview IS NOT NULL AND jsonb_typeof(preview) = 'object')
      OR (status <> 'READY' AND preview IS NULL))
    AND ((status = 'PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (status <> 'PROCESSING' AND lease_token IS NULL AND lease_until IS NULL))
    AND ((status = 'FAILED' AND failure_code IS NOT NULL) OR (status <> 'FAILED' AND failure_code IS NULL))
  );
COMMIT;
