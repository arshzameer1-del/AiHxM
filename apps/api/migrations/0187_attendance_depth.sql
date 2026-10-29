-- Attendance depth: rotating shifts, location checks (geofence, selfie, suspicious-location flags) and late/early penalty rules.
-- Everything here is off or empty until a company switches it on, so existing attendance behaves exactly as before.

-- ---------------------------------------------------------------- rotating shifts
-- A rotation is a container schedule (shifts.schedule_type = 'rotating') plus a cycle of member shifts: week 1 -> Morning, week 2 -> Evening.
-- The week in force on a date is floor(days since anchor_date / 7) mod cycle_weeks. An employee is assigned the container shift like any other
-- schedule; the resolver swaps in the member shift for that date, so attendance, leave and payroll see the real shift.
CREATE TABLE IF NOT EXISTS shift_rotations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id     uuid NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE CASCADE,
  cycle_weeks  integer NOT NULL CHECK (cycle_weeks BETWEEN 2 AND 12),
  anchor_date  date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shift_rotation_weeks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rotation_id      uuid NOT NULL REFERENCES shift_rotations(id) ON DELETE CASCADE,
  week_no          integer NOT NULL CHECK (week_no BETWEEN 1 AND 12),
  member_shift_id  uuid NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  UNIQUE (rotation_id, week_no)
);

-- ---------------------------------------------------------------- location checks
CREATE TABLE IF NOT EXISTS attendance_policy_settings (
  company_id              uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  geofence_mode           text NOT NULL DEFAULT 'off' CHECK (geofence_mode IN ('off', 'flag', 'block')),
  selfie_mode             text NOT NULL DEFAULT 'off' CHECK (selfie_mode IN ('off', 'optional', 'required')),
  block_suspect_location  boolean NOT NULL DEFAULT false,
  max_gps_accuracy_m      integer CHECK (max_gps_accuracy_m IS NULL OR max_gps_accuracy_m BETWEEN 5 AND 5000),
  max_travel_speed_kmh    integer NOT NULL DEFAULT 250 CHECK (max_travel_speed_kmh BETWEEN 20 AND 1200),
  updated_by              uuid REFERENCES user_accounts(id),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance_geofences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  latitude    numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m    integer NOT NULL CHECK (radius_m BETWEEN 20 AND 50000),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS gps_accuracy_m   numeric(8,1),
  ADD COLUMN IF NOT EXISTS geofence_id      uuid REFERENCES attendance_geofences(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_flags   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS selfie_path      text,
  ADD COLUMN IF NOT EXISTS selfie_mime      text;
CREATE INDEX IF NOT EXISTS idx_attendance_records_flagged ON attendance_records (company_id, work_date)
  WHERE geofence_result = 'outside' OR cardinality(location_flags) > 0;

-- ---------------------------------------------------------------- penalty rules
-- "Every 3 late arrivals of 10+ minutes in a month costs 1 day of annual leave" or "costs PKR 1,500".
-- Nothing is applied automatically: HR previews a month, then applies it, and can reverse an application.
CREATE TABLE IF NOT EXISTS attendance_penalty_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           text NOT NULL,
  trigger_kind   text NOT NULL CHECK (trigger_kind IN ('late', 'early_leave')),
  min_minutes    integer NOT NULL DEFAULT 1 CHECK (min_minutes BETWEEN 1 AND 600),
  every_n        integer NOT NULL CHECK (every_n BETWEEN 1 AND 31),
  penalty_type   text NOT NULL CHECK (penalty_type IN ('leave_deduction', 'salary_deduction')),
  leave_type     text,
  penalty_days   numeric(5,2) CHECK (penalty_days IS NULL OR penalty_days > 0),
  penalty_amount numeric(12,2) CHECK (penalty_amount IS NULL OR penalty_amount > 0),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CONSTRAINT attendance_penalty_shape CHECK (
    (penalty_type = 'leave_deduction' AND leave_type IS NOT NULL AND penalty_days IS NOT NULL)
    OR (penalty_type = 'salary_deduction' AND penalty_amount IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS attendance_penalty_applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_id               uuid NOT NULL REFERENCES attendance_penalty_rules(id) ON DELETE RESTRICT,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_month          date NOT NULL,
  occurrences           integer NOT NULL CHECK (occurrences >= 0),
  units                 integer NOT NULL CHECK (units > 0),
  penalty_days          numeric(7,2),
  penalty_amount        numeric(12,2),
  additional_payment_id uuid,
  status                text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'reversed')),
  applied_by            uuid REFERENCES user_accounts(id),
  applied_at            timestamptz NOT NULL DEFAULT now(),
  reversed_by           uuid REFERENCES user_accounts(id),
  reversed_at           timestamptz,
  UNIQUE (rule_id, employee_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_attendance_penalty_apps_month ON attendance_penalty_applications (company_id, period_month);

GRANT SELECT, INSERT, UPDATE, DELETE ON shift_rotations, shift_rotation_weeks, attendance_policy_settings, attendance_geofences,
  attendance_penalty_rules, attendance_penalty_applications TO app_role;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_rotations', 'shift_rotation_weeks', 'attendance_policy_settings', 'attendance_geofences', 'attendance_penalty_rules', 'attendance_penalty_applications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id()) WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())', t || '_all', t);
  END LOOP;
END $$;

INSERT INTO permissions (key, description) VALUES
  ('attendance_policy.manage', 'Set location checks (geofences, selfie, suspicious-location handling) and attendance penalty rules')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = 'hr_admin' AND p.key = 'attendance_policy.manage'
ON CONFLICT DO NOTHING;
