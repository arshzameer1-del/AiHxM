-- 0171_employee_statutory_ids.sql
-- BACKLOG49: the Pakistan statutory identifiers the platform was missing, one row per employee:
-- EOBI number, provincial social security (PESSI / SESSI) number, provident fund member number, CNIC issue and expiry,
-- and visa / work permit for foreign nationals. EOBI, social security and work permit numbers are stored encrypted.
-- Also: each beneficiary's share of the nominee total (family members), which must not exceed 100 per employee.

CREATE TABLE IF NOT EXISTS employee_statutory_ids (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  eobi_number                     text,
  eobi_registration_date          date,
  social_security_scheme          text CHECK (social_security_scheme IS NULL OR social_security_scheme IN ('pessi', 'sessi', 'other')),
  social_security_number          text,
  social_security_registration_date date,
  provident_fund_number           text,
  provident_fund_member_since     date,
  cnic_issue_date                 date,
  cnic_expiry_date                date,
  cnic_lifetime                   boolean NOT NULL DEFAULT false,
  visa_type                       text,
  visa_expiry_date                date,
  work_permit_number              text,
  work_permit_expiry_date         date,
  updated_by_user_account_id      uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id),
  CHECK (cnic_expiry_date IS NULL OR cnic_issue_date IS NULL OR cnic_expiry_date >= cnic_issue_date)
);

CREATE INDEX IF NOT EXISTS idx_employee_statutory_ids_company ON employee_statutory_ids (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_statutory_ids_cnic_expiry ON employee_statutory_ids (company_id, cnic_expiry_date) WHERE cnic_expiry_date IS NOT NULL;

ALTER TABLE employee_statutory_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_statutory_ids FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_statutory_ids_select ON employee_statutory_ids;
DROP POLICY IF EXISTS employee_statutory_ids_insert ON employee_statutory_ids;
DROP POLICY IF EXISTS employee_statutory_ids_update ON employee_statutory_ids;
CREATE POLICY employee_statutory_ids_select ON employee_statutory_ids FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_statutory_ids_insert ON employee_statutory_ids FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_statutory_ids_update ON employee_statutory_ids FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE ON employee_statutory_ids TO app_role;

-- nominee share
ALTER TABLE employee_family_members ADD COLUMN IF NOT EXISTS beneficiary_share_percent numeric(5,2);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_family_members_share_check') THEN
    ALTER TABLE employee_family_members ADD CONSTRAINT employee_family_members_share_check
      CHECK (beneficiary_share_percent IS NULL OR (beneficiary_share_percent > 0 AND beneficiary_share_percent <= 100));
  END IF;
END $$;
