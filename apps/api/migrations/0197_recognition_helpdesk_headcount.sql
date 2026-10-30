-- Recognition feed (thank-yous between colleagues), HR help desk with response-time clocks, and headcount plans.
-- Nothing is sent or changed automatically: a thank-you is written by a person, a ticket is answered by a person,
-- and a headcount plan only compares what HR typed in with what the system already holds.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS recognitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  to_employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  message      text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 500),
  value_tag    text CHECK (value_tag IS NULL OR length(btrim(value_tag)) BETWEEN 1 AND 40),
  given_on     date NOT NULL,
  hidden_at    timestamptz,
  hidden_by    uuid REFERENCES user_accounts(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_employee_id <> to_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_recognitions_feed ON recognitions (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recognitions_to ON recognitions (to_employee_id);
CREATE INDEX IF NOT EXISTS idx_recognitions_from_day ON recognitions (from_employee_id, given_on);

CREATE TABLE IF NOT EXISTS helpdesk_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  sla_hours   int CHECK (sla_hours IS NULL OR sla_hours BETWEEN 1 AND 720),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_helpdesk_categories ON helpdesk_categories (company_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS helpdesk_tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  category_id       uuid REFERENCES helpdesk_categories(id) ON DELETE SET NULL,
  category_name     text,
  subject           text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on_employee', 'resolved')),
  sla_hours         int,
  respond_by        timestamptz,
  first_response_at timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_company ON helpdesk_tickets (company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_employee ON helpdesk_tickets (employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS helpdesk_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES user_accounts(id),
  from_hr      boolean NOT NULL,
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_helpdesk_messages_ticket ON helpdesk_messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS headcount_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  fiscal_year text NOT NULL CHECK (length(btrim(fiscal_year)) BETWEEN 1 AND 20),
  note        text CHECK (note IS NULL OR length(note) <= 1000),
  created_by  uuid REFERENCES user_accounts(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS headcount_plan_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES headcount_plans(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  org_unit_id  uuid NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  planned_count int NOT NULL CHECK (planned_count BETWEEN 0 AND 100000),
  note         text CHECK (note IS NULL OR length(note) <= 300),
  UNIQUE (plan_id, org_unit_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recognitions', 'helpdesk_categories', 'helpdesk_tickets', 'helpdesk_messages', 'headcount_plans', 'headcount_plan_lines'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_role', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('recognition.moderate', 'Hide a thank-you from the recognition feed.'),
  ('helpdesk.manage', 'Answer help desk tickets, set response times and see the queue.'),
  ('headcount.manage', 'Write headcount plans and compare them with actual headcount.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin' AND p.key IN ('recognition.moderate', 'helpdesk.manage', 'headcount.manage')
ON CONFLICT DO NOTHING;
