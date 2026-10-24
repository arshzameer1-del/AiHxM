-- BACKLOG52 - what an employee can ask HR for from Self Service: a loan or a salary advance, and a letter or certificate
-- (salary certificate, employment letter, experience letter, NOC, address proof). Privacy requests already have their own
-- table (0057_data_subject_requests.sql); they only needed a screen.
--
-- One HR decision per request. For a loan or advance, approving creates the real loan through the loans service, so the
-- loan type limits, the guarantor rule and any approval template still apply. For a letter, HR issues it: a salary
-- certificate is generated from the employee's current salary and published to My Documents; any other letter is uploaded
-- to the employee's document vault. The request keeps a pointer to whatever was created.

CREATE TABLE IF NOT EXISTS employee_service_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_kind                  text NOT NULL CHECK (request_kind IN ('loan', 'salary_advance', 'letter')),
  -- loan / advance
  loan_type_id                  uuid REFERENCES loan_types(id) ON DELETE SET NULL,
  amount                        numeric(14,2) CHECK (amount IS NULL OR amount > 0),
  installments_count            integer CHECK (installments_count IS NULL OR installments_count BETWEEN 1 AND 600),
  -- letter
  letter_type                   text CHECK (letter_type IS NULL OR letter_type IN
                                  ('salary_certificate', 'employment_letter', 'experience_letter', 'noc', 'address_proof', 'other')),
  addressed_to                  text,
  -- both
  purpose                       text NOT NULL CHECK (length(btrim(purpose)) > 0),
  needed_by                     date,
  status                        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'rejected', 'cancelled')),
  requested_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  decided_by_user_account_id    uuid REFERENCES user_accounts(id),
  decided_at                    timestamptz,
  decision_note                 text,
  loan_id                       uuid REFERENCES employee_loans(id) ON DELETE SET NULL,
  generated_document_id         uuid REFERENCES generated_documents(id) ON DELETE SET NULL,
  employee_document_id          uuid REFERENCES employee_documents(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_service_requests_shape CHECK (
    (request_kind IN ('loan', 'salary_advance') AND amount IS NOT NULL AND letter_type IS NULL)
    OR (request_kind = 'letter' AND letter_type IS NOT NULL AND amount IS NULL AND installments_count IS NULL AND loan_type_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_employee_service_requests_employee ON employee_service_requests (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_service_requests_company_status ON employee_service_requests (company_id, status, request_kind);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_service_requests TO app_role;

ALTER TABLE employee_service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_service_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_service_requests_all ON employee_service_requests;
CREATE POLICY employee_service_requests_all ON employee_service_requests FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
