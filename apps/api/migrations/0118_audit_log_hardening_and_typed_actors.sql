-- Gap Register SEC-06 + INT-01 (Step 1): audit_log hardening and typed
-- actor columns.
--
-- SEC-06 — audit_log gains, ADDITIVELY (existing `actor` text, `target`,
-- `metadata` untouched and still written by every caller):
--   correlation_id  uuid   — ties an audit row to the request/job/event that
--                            caused it (register A2 rule 9)
--   source_channel  text   — 'api' | 'ui' | 'import' | 'job' | 'integration'
--                            | 'system' (free vocabulary, no CHECK: A3)
--   actor_id        uuid   — structured actor (user_accounts.id or
--                            platform_admins.id); `actor` text stays as the
--                            snapshot for service identities
--   actor_type      text   — 'user' | 'platform_admin' | 'service'
--   ip_address      inet
--   reason          text   — required-by-policy justification (break-glass,
--                            impersonation, config override)
--   before_data / after_data jsonb — explicit before/after snapshots
-- plus indexes on (company_id, target, created_at DESC) and (correlation_id),
-- and an APPEND-ONLY trigger: UPDATE and DELETE are rejected for everyone
-- including the owner, with exactly ONE exception — the FK's own
-- ON DELETE SET NULL (a deleted company nulls company_id and nothing else),
-- which tenant deletion and test cleanup rely on. TRUNCATE is rejected too.
-- app_role already had INSERT/SELECT only (0001); this closes the owner /
-- superuser path as well.
--
-- Backfill: actor_id/actor_type for existing rows only where the free-text
-- actor is a UUID that resolves to exactly one platform_admins / user_accounts
-- row (unambiguous-only, A2 rule 1). Re-runnable (touches only NULL actor_id).
-- The backfill runs BEFORE the append-only trigger is created in this same
-- migration, so no bypass switch is needed or provided.
--
-- INT-01 — the free-text actor columns elsewhere hold claims.sub (a UUID
-- string, either a user_accounts or a platform_admins id — so no single FK
-- target exists). RULE ADOPTED: keep the text as the immutable snapshot, add
-- a typed sibling `<col>_id uuid` filled by trigger whenever the text is a
-- valid UUID. Consumers can join either identity table; nothing is dropped.
--
-- ROLLBACK: DROP TRIGGER audit_log_append_only* ON audit_log; DROP FUNCTION
-- app.audit_log_append_only(); ALTER TABLE audit_log DROP COLUMN
-- correlation_id, source_channel, actor_id, actor_type, ip_address, reason,
-- before_data, after_data; DROP the sibling `*_id` columns and the
-- app.fill_actor_uuid() function and its triggers.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS correlation_id uuid;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'api';
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id uuid;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type text
  CHECK (actor_type IN ('user', 'platform_admin', 'service'));
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address inet;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS before_data jsonb;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS after_data jsonb;

CREATE INDEX IF NOT EXISTS idx_audit_log_company_target_created
  ON audit_log (company_id, target, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation
  ON audit_log (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id
  ON audit_log (actor_id) WHERE actor_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Backfill actor_id / actor_type (before the append-only trigger exists)
-- ---------------------------------------------------------------------
UPDATE audit_log a
   SET actor_id = pa.id, actor_type = 'platform_admin'
  FROM platform_admins pa
 WHERE a.actor_id IS NULL AND a.actor = pa.id::text;

UPDATE audit_log a
   SET actor_id = ua.id, actor_type = 'user'
  FROM user_accounts ua
 WHERE a.actor_id IS NULL AND a.actor = ua.id::text;

UPDATE audit_log SET actor_type = 'service'
 WHERE actor_type IS NULL
   AND actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ---------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log is append-only: DELETE is not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The only permitted UPDATE: the FK's ON DELETE SET NULL nulling company_id.
  IF TG_OP = 'UPDATE'
     AND OLD.company_id IS NOT NULL AND NEW.company_id IS NULL
     AND (to_jsonb(OLD) - 'company_id') = (to_jsonb(NEW) - 'company_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted' USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_log_append_only_row ON audit_log;
CREATE TRIGGER audit_log_append_only_row
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_append_only();

CREATE OR REPLACE FUNCTION app.audit_log_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted' USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_no_truncate();

-- ---------------------------------------------------------------------
-- INT-01: typed actor siblings for free-text actor columns
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fill_actor_uuid() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  src text := TG_ARGV[0];
  dst text := TG_ARGV[1];
  val text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF val IS NOT NULL AND val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(dst, val));
  ELSE
    NEW := jsonb_populate_record(NEW, jsonb_build_object(dst, NULL));
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  spec record;
  sibling text;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('companies', 'deletion_requested_by'),
      ('companies', 'deletion_approved_by'),
      ('platform_saved_views', 'created_by'),
      ('support_tickets', 'created_by'),
      ('support_tickets', 'assignee'),
      ('tenant_backups', 'requested_by'),
      ('tenant_configuration', 'updated_by'),
      ('tenant_data_exports', 'requested_by'),
      ('tenant_export_encryption_keys', 'updated_by'),
      ('tenant_integrations', 'updated_by')
    ) AS t(tbl, col)
  LOOP
    sibling := spec.col || '_id';
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I uuid', spec.tbl, sibling);
    EXECUTE format(
      'UPDATE %I SET %I = %I::uuid WHERE %I IS NULL AND %I ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''',
      spec.tbl, sibling, spec.col, sibling, spec.col);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_' || spec.tbl || '_' || sibling, spec.tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.fill_actor_uuid(%L, %L)',
      'trg_' || spec.tbl || '_' || sibling, spec.tbl, spec.col, sibling);
  END LOOP;
END $$;
