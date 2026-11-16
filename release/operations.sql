-- One-time setup by the trusted release operator, never an application trigger.
-- The executing role owns this schema. Do not grant it to application identities.
BEGIN;
CREATE SCHEMA IF NOT EXISTS mtl_operations;
REVOKE ALL ON SCHEMA mtl_operations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS mtl_operations.environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  project_id text NOT NULL,
  baseline_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mtl_operations.migration (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  commit_sha text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mtl_operations.release (
  commit_sha text NOT NULL,
  manifest_checksum text NOT NULL,
  migration_checksum text NOT NULL,
  state text NOT NULL CHECK (state IN ('deploying','failed','deployed','verified')),
  stages jsonb NOT NULL DEFAULT '{}',
  resource_fingerprint text,
  accepted_by text,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (commit_sha,manifest_checksum)
);
REVOKE ALL ON ALL TABLES IN SCHEMA mtl_operations FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA mtl_operations REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA mtl_operations REVOKE ALL ON FUNCTIONS FROM PUBLIC;
-- SQL Connect owner defaults can grant new tables to these roles even outside
-- public. Revoke direct grants; effective inherited access is verified separately.
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE
    rolname LIKE 'firebasereader_%' OR rolname LIKE 'firebasewriter_%'
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA mtl_operations FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA mtl_operations FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA mtl_operations FROM %I',role_name);
  END LOOP;
END $$;
COMMIT;
