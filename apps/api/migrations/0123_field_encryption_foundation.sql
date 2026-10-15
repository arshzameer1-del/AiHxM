-- Gap Register SEC-02 / SEC-03 / SEC-04 (Step 2) — foundation for application-
-- level envelope encryption with blind indexes. See src/crypto/field-crypto.ts
-- for the design. THIS MIGRATION ONLY ADDS STRUCTURE: no existing value is
-- changed. Conversion of existing rows is the resumable backfill
-- (EncryptionBackfillService), run per tenant after deploy.
--
--   tenant_data_keys      per-tenant keys WRAPPED under the master key held in
--                         the FIELD_ENCRYPTION_KEY environment variable
--                         (never in the database). purpose 'dek' = AES-256-GCM
--                         data key (versioned, rotatable); 'bidx' = HMAC key
--                         for blind indexes (stable).
--   *_bidx columns        blind indexes for fields that need equality lookup /
--                         duplicate detection (CNIC, account number, IBAN).
--   *_enc date columns    dates cannot hold ciphertext, so date_of_birth gets a
--                         parallel text column; the plaintext date column is
--                         set NULL by the application once written encrypted.
--   persons uniqueness    (company_id, cnic) unique index is replaced in
--                         PRODUCT BEHAVIOUR by (company_id, cnic_bidx); the old
--                         index stays (harmless) until the plaintext is gone.
--
-- Rollback: DROP TABLE tenant_data_keys; drop the added *_bidx / *_enc columns.
-- (Do NOT roll back after ciphertext has been written: values would be lost
--  without the keys. There is no reverse backfill; before running the real
--  backfill take a database backup -- that backup is the rollback path.)

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS tenant_data_keys (
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('dek', 'bidx')),
  key_version  int  NOT NULL CHECK (key_version >= 1),
  wrapped_key  text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, purpose, key_version)
);
-- at most one active key per (company, purpose)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_data_keys_one_active
  ON tenant_data_keys (company_id, purpose) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE ON tenant_data_keys TO app_role;
ALTER TABLE tenant_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_data_keys_all ON tenant_data_keys FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- Blind indexes
ALTER TABLE employees               ADD COLUMN IF NOT EXISTS cnic_bidx text;
ALTER TABLE persons                 ADD COLUMN IF NOT EXISTS cnic_bidx text;
ALTER TABLE employee_family_members ADD COLUMN IF NOT EXISTS cnic_bidx text;
ALTER TABLE employee_payment_accounts ADD COLUMN IF NOT EXISTS account_number_bidx text;
ALTER TABLE employee_payment_accounts ADD COLUMN IF NOT EXISTS iban_bidx text;

CREATE INDEX IF NOT EXISTS idx_employees_cnic_bidx ON employees (company_id, cnic_bidx) WHERE cnic_bidx IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_company_cnic_bidx ON persons (company_id, cnic_bidx) WHERE cnic_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_family_members_cnic_bidx ON employee_family_members (company_id, cnic_bidx) WHERE cnic_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_accounts_account_bidx ON employee_payment_accounts (company_id, account_number_bidx) WHERE account_number_bidx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_accounts_iban_bidx ON employee_payment_accounts (company_id, iban_bidx) WHERE iban_bidx IS NOT NULL;

-- Encrypted date of birth
ALTER TABLE employees               ADD COLUMN IF NOT EXISTS date_of_birth_enc text;
ALTER TABLE persons                 ADD COLUMN IF NOT EXISTS date_of_birth_enc text;
ALTER TABLE employee_family_members ADD COLUMN IF NOT EXISTS date_of_birth_enc text;

-- SEC-03: integration secrets (ciphertext lives in the existing text column;
-- config jsonb secrets are encrypted key-by-key by the application)
-- (no structural change needed: previous_secret_value is text)
