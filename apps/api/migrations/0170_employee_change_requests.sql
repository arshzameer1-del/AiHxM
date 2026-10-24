-- 0170_employee_change_requests.sql
-- BACKLOG48: an employee asks HR to change their own contact details, addresses, family members, marital status or
-- bank account. Nothing on the employee record changes until HR approves; bank accounts also stay "pending" in the
-- payment accounts table until approved (maker-checker: the employee submits, HR approves).

CREATE TABLE IF NOT EXISTS employee_change_requests (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                 uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_type                text NOT NULL CHECK (request_type IN ('contact', 'address', 'family_member', 'marital_status', 'bank_account')),
  action                      text NOT NULL DEFAULT 'add' CHECK (action IN ('add', 'update', 'end')),
  target_id                   uuid,
  payload                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary                     text NOT NULL,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  payment_account_id          uuid REFERENCES employee_payment_accounts(id) ON DELETE SET NULL,
  submitted_by_user_account_id uuid,
  submitted_at                timestamptz NOT NULL DEFAULT now(),
  decided_by_user_account_id  uuid,
  decided_at                  timestamptz,
  decision_note               text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_change_requests_company_status ON employee_change_requests (company_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_change_requests_employee ON employee_change_requests (employee_id, submitted_at DESC);
-- at most one open request per existing record
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_change_requests_one_open_per_target
  ON employee_change_requests (request_type, target_id) WHERE status = 'pending' AND target_id IS NOT NULL;

ALTER TABLE employee_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_change_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_change_requests_select ON employee_change_requests;
DROP POLICY IF EXISTS employee_change_requests_insert ON employee_change_requests;
DROP POLICY IF EXISTS employee_change_requests_update ON employee_change_requests;
CREATE POLICY employee_change_requests_select ON employee_change_requests FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_change_requests_insert ON employee_change_requests FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY employee_change_requests_update ON employee_change_requests FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE ON employee_change_requests TO app_role;
