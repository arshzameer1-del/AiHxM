-- Business travel: a request approved ahead of the trip, an optional advance, and a settlement afterwards.
-- Per-diem and mileage rates are the company's own; nothing here is a statutory rate.
CREATE TABLE IF NOT EXISTS travel_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  rate_kind     text NOT NULL CHECK (rate_kind IN ('per_diem', 'mileage')),
  trip_type     text NOT NULL DEFAULT 'domestic' CHECK (trip_type IN ('domestic', 'international')),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS travel_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  destination                text NOT NULL,
  purpose                    text NOT NULL,
  trip_type                  text NOT NULL DEFAULT 'domestic' CHECK (trip_type IN ('domestic', 'international')),
  travel_mode                text NOT NULL DEFAULT 'other' CHECK (travel_mode IN ('air', 'car', 'bus', 'train', 'other')),
  start_date                 date NOT NULL,
  end_date                   date NOT NULL CHECK (end_date >= start_date),
  est_distance_km            numeric(8,1) CHECK (est_distance_km IS NULL OR est_distance_km >= 0),
  est_other_cost             numeric(12,2) CHECK (est_other_cost IS NULL OR est_other_cost >= 0),
  advance_requested          numeric(12,2) NOT NULL DEFAULT 0 CHECK (advance_requested >= 0),
  status                     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled', 'settled')),
  workflow_instance_id       uuid REFERENCES workflow_instances(id) ON DELETE SET NULL,
  submitted_by_user_account_id uuid NOT NULL REFERENCES user_accounts(id),
  decided_by_user_account_id uuid REFERENCES user_accounts(id),
  decision_comment           text,
  decided_at                 timestamptz,
  -- advance paid through payroll as an additional payment
  advance_amount             numeric(12,2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  advance_payment_id         uuid,
  advance_issued_at          timestamptz,
  -- settlement
  settled_at                 timestamptz,
  settled_by_user_account_id uuid REFERENCES user_accounts(id),
  actual_days                integer CHECK (actual_days IS NULL OR actual_days >= 0),
  actual_km                  numeric(8,1) CHECK (actual_km IS NULL OR actual_km >= 0),
  per_diem_rate              numeric(12,2),
  mileage_rate               numeric(12,2),
  per_diem_amount            numeric(12,2),
  mileage_amount             numeric(12,2),
  other_cost                 numeric(12,2),
  other_cost_note            text,
  total_cost                 numeric(12,2),
  net_amount                 numeric(12,2),
  settlement_payment_id      uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT travel_settled_has_totals CHECK (status <> 'settled' OR (total_cost IS NOT NULL AND net_amount IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_travel_requests_employee ON travel_requests (employee_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_travel_requests_company_status ON travel_requests (company_id, status);
CREATE INDEX IF NOT EXISTS idx_travel_requests_workflow ON travel_requests (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON travel_rates, travel_requests TO app_role;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['travel_rates', 'travel_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
INSERT INTO permissions (key, description) VALUES
  ('travel.request.self', 'Ask to travel on company business and settle your own trip'),
  ('travel.decide.team', 'Decide travel requests of your direct reports'),
  ('travel.decide.all', 'Decide any travel request'),
  ('travel.manage', 'Set per-diem and mileage rates, issue advances and settle trips')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE (r.key = 'hr_admin' AND p.key IN ('travel.request.self', 'travel.decide.all', 'travel.decide.team', 'travel.manage'))
    OR (r.key = 'line_manager' AND p.key IN ('travel.request.self', 'travel.decide.team'))
    OR (r.key = 'employee_self_service' AND p.key = 'travel.request.self')
ON CONFLICT DO NOTHING;
