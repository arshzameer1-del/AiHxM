-- Company asset register: every laptop, phone, vehicle and access card the company owns, who holds it, what was done to it
-- (maintenance, loss, transfer) and how it left the books. The older employee_assets table stays the per-employee list the
-- profile and reports read; an assignment here also writes a row there, and a return closes it, so both always agree.

CREATE TABLE IF NOT EXISTS asset_register (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_tag            text NOT NULL,
  name                 text NOT NULL,
  category             text NOT NULL CHECK (category IN ('laptop', 'desktop', 'mobile', 'tablet', 'vehicle', 'furniture', 'access_card', 'uniform', 'tool', 'other')),
  serial_number        text,
  vendor               text,
  purchase_date        date,
  purchase_cost        numeric(14,2) CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  warranty_until       date,
  location             text,
  status               text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'assigned', 'under_maintenance', 'lost', 'retired')),
  current_employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  last_verified_on     date,
  retired_on           date,
  disposal_method      text CHECK (disposal_method IS NULL OR disposal_method IN ('sold', 'scrapped', 'donated', 'returned_to_vendor')),
  disposal_value       numeric(14,2) CHECK (disposal_value IS NULL OR disposal_value >= 0),
  notes                text,
  created_by           uuid REFERENCES user_accounts(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, asset_tag),
  CONSTRAINT asset_register_holder_ck CHECK ((status = 'assigned') = (current_employee_id IS NOT NULL)),
  CONSTRAINT asset_register_retired_ck CHECK ((status = 'retired') = (retired_on IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_asset_register_company_status ON asset_register (company_id, status);
CREATE INDEX IF NOT EXISTS idx_asset_register_holder ON asset_register (current_employee_id) WHERE current_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS asset_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_id           uuid NOT NULL REFERENCES asset_register(id) ON DELETE CASCADE,
  event_type         text NOT NULL CHECK (event_type IN ('registered', 'updated', 'assigned', 'returned', 'transferred', 'maintenance_started', 'maintenance_completed', 'marked_lost', 'found', 'retired', 'verified')),
  employee_id        uuid REFERENCES employees(id) ON DELETE SET NULL,
  from_employee_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  occurred_on        date NOT NULL DEFAULT CURRENT_DATE,
  condition          text CHECK (condition IS NULL OR condition IN ('new', 'good', 'fair', 'poor', 'damaged')),
  cost               numeric(14,2) CHECK (cost IS NULL OR cost >= 0),
  note               text,
  employee_asset_id  uuid REFERENCES employee_assets(id) ON DELETE SET NULL,
  acknowledged_at    timestamptz,
  recorded_by        uuid REFERENCES user_accounts(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_events_asset ON asset_events (asset_id, created_at);
CREATE INDEX IF NOT EXISTS idx_asset_events_holder ON asset_events (employee_id, event_type) WHERE event_type IN ('assigned', 'transferred');

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_register, asset_events TO app_role;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_register', 'asset_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);
INSERT INTO permissions (key, description) VALUES
  ('asset.manage', 'Keep the company asset register: add assets, issue and take back, maintenance, loss and disposal'),
  ('asset.view.self', 'See the assets issued to you and confirm you received them')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = 'hr_admin' AND p.key = 'asset.manage'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.key IN ('hr_admin', 'line_manager', 'employee_self_service') AND p.key = 'asset.view.self'
ON CONFLICT DO NOTHING;
