-- Apply with a trusted PostgreSQL connection AFTER the reviewed SQL Connect
-- schema/connector deployment; COMPATIBLE validation rejects these extra CHECKs
-- and FK delete rules during schema deployment. See README.md before future
-- schema changes. This file never deploys itself. Run in one
-- transaction; rerunning is safe. Compatible validation remains enabled.
-- Review future generated migrations: SQL Connect does not model these checks,
-- triggers, or RESTRICT delete actions. Do not replace them with CASCADE.
BEGIN;

DO $checks$
DECLARE spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('customer_order', 'customer_order_values_check',
      $$subtotal_cents >= 0 AND item_count > 0 AND discount_cents BETWEEN 0 AND subtotal_cents
        AND deposit_required_cents >= 0 AND final_total_cents >= 0
        AND cancellation_total_cents >= 0 AND revision >= 0
        AND fulfillment_type = 'PICKUP' AND status IN ('CONFIRMED','PAID','COMPLETED','CANCELLED')
        AND order_number ~ '^[2-9A-HJKMNP-Z]{6}$'
        AND (contact_phone_number IS NULL OR contact_phone_number ~ '^\+[1-9][0-9]{1,14}$')
        AND ((status IN ('CONFIRMED','PAID') AND completed_at IS NULL AND cancelled_at IS NULL AND cancellation_total_cents IS NULL)
          OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND cancellation_total_cents IS NULL)
          OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancellation_total_cents IS NOT NULL))$$),
    ('order_item', 'order_item_values_check',
      'quantity > 0 AND unit_price_cents >= 0 AND catalog_unit_price_cents >= 0 AND quantity::bigint * unit_price_cents <= 2147483647'),
    ('payment', 'payment_values_check',
      $$amount_cents > 0 AND method = 'CASH' AND status IN ('SUCCEEDED','VOIDED') AND provider IS NULL AND provider_reference IS NULL$$),
    ('refund', 'refund_values_check',
      $$amount_cents > 0 AND status IN ('SUCCEEDED','VOIDED')$$),
    ('order_audit_event', 'order_audit_values_check',
      $$actor_uid <> '' AND action <> '' AND order_revision >= 0
        AND jsonb_typeof(changes) = 'object' AND changes ? 'before' AND changes ? 'after'$$)
  ) AS v(table_name, constraint_name, predicate)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || spec.table_name)::regclass AND conname = spec.constraint_name) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)',
        spec.table_name, spec.constraint_name, spec.predicate);
    END IF;
  END LOOP;
END $checks$;

-- Preserve history instead of cascading away items, ledgers or audit events.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN SELECT c.conname, c.conrelid::regclass AS table_name,
    pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.contype = 'f' AND c.confdeltype IN ('c','n')
      AND c.conrelid IN ('public.customer_order'::regclass, 'public.order_item'::regclass,
        'public.payment'::regclass, 'public.refund'::regclass, 'public.order_audit_event'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.table_name, fk.conname,
      replace(replace(fk.definition, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'),
        'ON DELETE SET NULL', 'ON DELETE RESTRICT'));
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.reject_order_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Order audit history is append-only' USING ERRCODE = '23514';
END
$function$;
DROP TRIGGER IF EXISTS order_audit_immutable ON public.order_audit_event;
CREATE TRIGGER order_audit_immutable BEFORE UPDATE OR DELETE ON public.order_audit_event
FOR EACH ROW EXECUTE FUNCTION public.reject_order_audit_mutation();
DROP TRIGGER IF EXISTS order_audit_no_truncate ON public.order_audit_event;
CREATE TRIGGER order_audit_no_truncate BEFORE TRUNCATE ON public.order_audit_event
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_order_audit_mutation();

CREATE OR REPLACE FUNCTION public.preserve_order_identity() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_number IS DISTINCT FROM OLD.order_number
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Order identity and creation time are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS order_identity_immutable ON public.customer_order;
CREATE TRIGGER order_identity_immutable BEFORE UPDATE ON public.customer_order
FOR EACH ROW EXECUTE FUNCTION public.preserve_order_identity();

COMMIT;
