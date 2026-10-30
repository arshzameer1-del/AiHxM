-- Statutory working papers: minimum-wage table and WWF / WPPF levy worksheets.
--
-- Nothing here ships with a rate, a threshold or a province list. Every figure is typed in by the company (from the
-- notification or the accountant's advice), is dated, and carries the note saying where it came from. The worksheets
-- calculate a figure for a person to review; nothing is deducted, posted or paid from them.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS minimum_wage_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  province        text NOT NULL CHECK (length(btrim(province)) BETWEEN 1 AND 80),
  monthly_amount  numeric(12,2) NOT NULL CHECK (monthly_amount > 0),
  effective_from  date NOT NULL,
  source_note     text CHECK (source_note IS NULL OR length(source_note) <= 500),
  created_by      uuid REFERENCES user_accounts(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_minimum_wage_rates ON minimum_wage_rates (company_id, lower(btrim(province)), effective_from);

CREATE TABLE IF NOT EXISTS levy_worksheets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('wwf', 'wppf')),
  fiscal_year   text NOT NULL CHECK (length(btrim(fiscal_year)) BETWEEN 1 AND 20),
  base_label    text NOT NULL CHECK (length(btrim(base_label)) BETWEEN 1 AND 120),
  base_amount   numeric(16,2) NOT NULL CHECK (base_amount >= 0),
  rate_percent  numeric(7,3) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  amount        numeric(16,2) NOT NULL CHECK (amount >= 0),
  notes         text CHECK (notes IS NULL OR length(notes) <= 1000),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  prepared_by   uuid REFERENCES user_accounts(id),
  finalized_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_levy_worksheets_company ON levy_worksheets (company_id, kind, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON minimum_wage_rates, levy_worksheets TO app_role;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['minimum_wage_rates', 'levy_worksheets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('minimum_wage.manage', 'Keep the minimum-wage table (per province, per date) the minimum-wage check compares salaries with.'),
  ('levy.manage', 'Prepare and finalise WWF and WPPF worksheets.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('minimum_wage.manage', 'levy.manage')
ON CONFLICT DO NOTHING;
