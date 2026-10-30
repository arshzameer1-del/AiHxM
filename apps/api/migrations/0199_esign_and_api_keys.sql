-- Documents to sign (typed-name consent with a tamper-evident receipt) and read-only API keys.
--
-- Signing here is "I have read this and I agree", recorded with the exact text, the signer's typed name and a hash that ties the two
-- together. It is not a certified or digital-certificate signature; whether it is enough for a given document is for the company's
-- lawyer to decide. Nothing is sent or signed on anyone's behalf.
--
-- API keys are shown once, stored only as a hash, can only read, and can be revoked at any time.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS esign_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body            text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  body_sha256     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'declined', 'cancelled')),
  due_on          date,
  signed_name     text,
  signed_at       timestamptz,
  receipt_sha256  text,
  decline_reason  text CHECK (decline_reason IS NULL OR length(decline_reason) <= 500),
  created_by      uuid REFERENCES user_accounts(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_signed_fields CHECK ((status = 'signed') = (signed_at IS NOT NULL AND signed_name IS NOT NULL AND receipt_sha256 IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_esign_company ON esign_requests (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_esign_employee ON esign_requests (employee_id, status);

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  key_prefix    text NOT NULL,
  key_sha256    text NOT NULL UNIQUE,
  scopes        text[] NOT NULL CHECK (cardinality(scopes) >= 1),
  created_by    uuid REFERENCES user_accounts(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys (company_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['esign_requests', 'api_keys'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('esign.manage', 'Send documents to employees to sign and see who has signed.'),
  ('api_key.manage', 'Create and revoke read-only API keys.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('esign.manage', 'api_key.manage')
ON CONFLICT DO NOTHING;
