-- BACKLOG54 - three more pieces of the employee record that had no home:
--   * languages an employee speaks and writes (skills and certificates already live in employee_qualifications)
--   * medical information (blood group, allergies, conditions, a note for emergencies)  -- strict access
--   * disciplinary records (warnings, show-cause notices, suspensions)                  -- strict access
--
-- Strict access means NEW permissions that only hr_admin holds. Line managers, finance, system admins and everyone else
-- do not get them. An employee reaches their own medical information and their own disciplinary records through
-- "this is me" (employee.view.self), not through these permissions. Idempotent.
--
-- ROLLBACK:
--   DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key LIKE 'employee.medical.%' OR key LIKE 'employee.disciplinary.%');
--   DELETE FROM permissions WHERE key LIKE 'employee.medical.%' OR key LIKE 'employee.disciplinary.%';
--   DROP TABLE IF EXISTS employee_disciplinary_records, employee_medical_info, employee_languages;

CREATE TABLE IF NOT EXISTS employee_languages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  language       text NOT NULL CHECK (length(btrim(language)) > 0),
  spoken_level   text NOT NULL DEFAULT 'conversational' CHECK (spoken_level IN ('basic', 'conversational', 'fluent', 'native')),
  written_level  text NOT NULL DEFAULT 'conversational' CHECK (written_level IN ('basic', 'conversational', 'fluent', 'native')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_languages_one_per_language ON employee_languages (employee_id, lower(btrim(language)));
CREATE INDEX IF NOT EXISTS idx_employee_languages_company ON employee_languages (company_id);

CREATE TABLE IF NOT EXISTS employee_medical_info (
  employee_id                  uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  blood_group                  text CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  -- free text below is encrypted at rest (crypto/sensitive-fields)
  allergies                    text,
  chronic_conditions           text,
  disability_note              text,
  emergency_medical_note       text,
  updated_by_user_account_id   uuid REFERENCES user_accounts(id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_medical_info_company ON employee_medical_info (company_id);

CREATE TABLE IF NOT EXISTS employee_disciplinary_records (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  record_type                  text NOT NULL CHECK (record_type IN ('verbal_warning', 'written_warning', 'final_warning', 'show_cause', 'suspension', 'other')),
  subject                      text NOT NULL CHECK (length(btrim(subject)) > 0),
  description                  text NOT NULL CHECK (length(btrim(description)) > 0),
  incident_date                date,
  issued_date                  date NOT NULL DEFAULT CURRENT_DATE,
  action_taken                 text,
  status                       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  withdrawn_reason             text,
  withdrawn_at                 timestamptz,
  issued_by_user_account_id    uuid REFERENCES user_accounts(id),
  acknowledged_at              timestamptz,
  employee_comment             text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_disciplinary_withdrawn_shape CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_employee_disciplinary_employee ON employee_disciplinary_records (employee_id, issued_date DESC);
CREATE INDEX IF NOT EXISTS idx_employee_disciplinary_company ON employee_disciplinary_records (company_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_languages TO app_role;
GRANT SELECT, INSERT, UPDATE ON employee_medical_info TO app_role;
-- disciplinary records are never deleted: HR withdraws them and the history stays
GRANT SELECT, INSERT, UPDATE ON employee_disciplinary_records TO app_role;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_languages', 'employee_medical_info', 'employee_disciplinary_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())',
      t || '_all', t);
  END LOOP;
END $$;

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO permissions (key, description) VALUES
  ('employee.medical.view',        'See any employee''s medical information (blood group, allergies, conditions).'),
  ('employee.medical.manage',      'Change any employee''s medical information.'),
  ('employee.disciplinary.view',   'See any employee''s disciplinary records.'),
  ('employee.disciplinary.manage', 'Issue and withdraw disciplinary records.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin'
  AND p.key IN ('employee.medical.view', 'employee.medical.manage', 'employee.disciplinary.view', 'employee.disciplinary.manage')
ON CONFLICT DO NOTHING;
