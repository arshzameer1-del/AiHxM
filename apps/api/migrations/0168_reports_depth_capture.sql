-- Reports depth: data the library needs but the product did not record yet.
--  - courses.is_mandatory / cost_amount     -> L03 Mandatory Training Compliance, L06 Training Cost Summary
--  - payslip_access_log                     -> I05 Payslip Access Summary (who opened which payslip, never its contents)
--  - data_quality_snapshots                 -> M14 Workforce Data Quality Trend (daily completeness of A14 fields)

ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_mandatory boolean NOT NULL DEFAULT false;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS cost_amount numeric(12,2) CHECK (cost_amount IS NULL OR cost_amount >= 0);

CREATE TABLE IF NOT EXISTS payslip_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  payslip_id uuid REFERENCES payslips(id) ON DELETE CASCADE,
  document_id uuid REFERENCES generated_documents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('payslip', 'document')),
  viewer_user_account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'app')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'payslip' AND payslip_id IS NOT NULL) OR (kind = 'document' AND document_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_payslip_access_company_time ON payslip_access_log (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payslip_access_payslip ON payslip_access_log (payslip_id, viewer_user_account_id, created_at);

CREATE TABLE IF NOT EXISTS data_quality_snapshots (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  field_order smallint NOT NULL,
  field text NOT NULL,
  total integer NOT NULL CHECK (total >= 0),
  filled integer NOT NULL CHECK (filled >= 0),
  PRIMARY KEY (company_id, snapshot_date, field_order)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payslip_access_log', 'data_quality_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL
      USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
      WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
  END LOOP;
END $$;
