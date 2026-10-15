-- Gap Register TLM-04, TLM-05, TLM-06 (Step 8B). ADDITIVE.
--
--  TLM-04  attendance_daily_results: one PROCESSED row per employee per work date
--          (status present / absent / late / early_departure / late_and_early / half_day /
--          on_leave / on_duty / holiday / rest_day / no_schedule, scheduled / worked / late /
--          early minutes, first in / last out, exceptions, the leave or on-duty request that
--          explains it, HR override). Produced by the time-evaluation job; ESS and payroll
--          read this, not raw punches. attendance_records gains shift_id, device_id,
--          work_date, derived_status, geofence_result, approval_state (backfilled).
--  TLM-05  attendance_devices (+ hashed ingestion key), device_enrollments (device user id ->
--          employee) and raw_punches (every received punch, de-duplicated by an idempotency
--          key, with its processing outcome) so a device can re-send a batch safely.
--  TLM-06  timesheets + timesheet_entries (weekly/period sheet per employee, cost-centre /
--          task per entry, submitted through the workflow engine).
--
-- ROLLBACK: DROP TABLE timesheet_entries, timesheets, raw_punches, device_enrollments,
--   attendance_devices, attendance_daily_results; ALTER TABLE attendance_records DROP the
--   added columns; ALTER TABLE tenant_integrations is untouched.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

-- ------------------------------------------------------------ TLM-05 devices
CREATE TABLE IF NOT EXISTS attendance_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  device_type     text NOT NULL DEFAULT 'biometric' CHECK (device_type IN ('biometric', 'face', 'card', 'mobile', 'kiosk')),
  vendor          text,
  serial_number   text,
  location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
  timezone        text NOT NULL DEFAULT 'Asia/Karachi',
  api_key_hash    text,
  api_key_prefix  text,
  is_active       boolean NOT NULL DEFAULT true,
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_devices_serial ON attendance_devices (company_id, serial_number) WHERE serial_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES attendance_devices(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- the id the device itself uses for this person (never the internal uuid)
  device_user_id  text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  UNIQUE (device_id, device_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_enrollments_active ON device_enrollments (device_id, employee_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_device_enrollments_employee ON device_enrollments (employee_id);

ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS shift_id          uuid REFERENCES shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_id         uuid REFERENCES attendance_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS work_date         date,
  ADD COLUMN IF NOT EXISTS derived_status    text,
  ADD COLUMN IF NOT EXISTS geofence_result   text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS approval_state    text NOT NULL DEFAULT 'auto_approved';
ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_geofence_ck;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_geofence_ck CHECK (geofence_result IN ('not_applicable', 'inside', 'outside', 'unknown'));
ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_approval_state_ck;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_approval_state_ck CHECK (approval_state IN ('auto_approved', 'pending', 'approved', 'rejected'));
UPDATE attendance_records SET work_date = (clock_in_at AT TIME ZONE 'Asia/Karachi')::date WHERE work_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_records_work_date ON attendance_records (employee_id, work_date);

CREATE TABLE IF NOT EXISTS raw_punches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id             uuid NOT NULL REFERENCES attendance_devices(id) ON DELETE CASCADE,
  device_user_id        text NOT NULL,
  employee_id           uuid REFERENCES employees(id) ON DELETE SET NULL,
  punched_at            timestamptz NOT NULL,
  direction             text NOT NULL DEFAULT 'unknown' CHECK (direction IN ('in', 'out', 'unknown')),
  idempotency_key       text NOT NULL,
  status                text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'duplicate', 'unmatched', 'rejected')),
  attendance_record_id  uuid REFERENCES attendance_records(id) ON DELETE SET NULL,
  error                 text,
  raw_payload           jsonb,
  received_at           timestamptz NOT NULL DEFAULT now(),
  processed_at          timestamptz,
  UNIQUE (device_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_raw_punches_employee ON raw_punches (employee_id, punched_at);
CREATE INDEX IF NOT EXISTS idx_raw_punches_unmatched ON raw_punches (company_id, device_id) WHERE status IN ('unmatched', 'rejected');

-- ------------------------------------------------------------ TLM-04 daily results
CREATE TABLE IF NOT EXISTS attendance_daily_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date            date NOT NULL,
  shift_id             uuid REFERENCES shifts(id) ON DELETE SET NULL,
  schedule_name        text,
  status               text NOT NULL CHECK (status IN ('present', 'absent', 'late', 'early_departure', 'late_and_early', 'half_day', 'on_leave', 'on_duty', 'holiday', 'rest_day', 'no_schedule')),
  scheduled_minutes    integer NOT NULL DEFAULT 0 CHECK (scheduled_minutes >= 0),
  worked_minutes       integer NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  late_minutes         integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_leave_minutes  integer NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0),
  first_in_at          timestamptz,
  last_out_at          timestamptz,
  punch_count          integer NOT NULL DEFAULT 0,
  leave_request_id     uuid REFERENCES leave_requests(id) ON DELETE SET NULL,
  on_duty_request_id   uuid REFERENCES on_duty_requests(id) ON DELETE SET NULL,
  exceptions           text[] NOT NULL DEFAULT '{}',
  source               text NOT NULL DEFAULT 'evaluation' CHECK (source IN ('evaluation', 'manual_override')),
  is_overridden        boolean NOT NULL DEFAULT false,
  overridden_by_user_account_id uuid REFERENCES user_accounts(id),
  override_reason      text,
  overridden_at        timestamptz,
  evaluated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_daily_company_date ON attendance_daily_results (company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_daily_status ON attendance_daily_results (company_id, work_date, status);

-- ------------------------------------------------------------ TLM-06 timesheets
CREATE TABLE IF NOT EXISTS timesheets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'returned', 'cancelled')),
  total_minutes         integer NOT NULL DEFAULT 0 CHECK (total_minutes >= 0),
  submitted_at          timestamptz,
  submitted_by_user_account_id uuid REFERENCES user_accounts(id),
  decided_by_user_account_id   uuid REFERENCES user_accounts(id),
  decided_at            timestamptz,
  decision_comment      text,
  workflow_instance_id  uuid REFERENCES workflow_instances(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (employee_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_timesheets_company_status ON timesheets (company_id, status);
CREATE INDEX IF NOT EXISTS idx_timesheets_workflow ON timesheets (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS timesheet_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  timesheet_id   uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  work_date      date NOT NULL,
  minutes        integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  cost_center_id uuid REFERENCES cost_centers(id) ON DELETE SET NULL,
  task_ref       text,
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_timesheet_entries_sheet ON timesheet_entries (timesheet_id, work_date);

-- ------------------------------------------------------------ RLS + grants
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_devices, device_enrollments, raw_punches, attendance_daily_results, timesheets, timesheet_entries TO app_role;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_devices', 'device_enrollments', 'raw_punches', 'attendance_daily_results', 'timesheets', 'timesheet_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t::regclass AND p.polname = t || '_all') THEN
      EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL
        USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
        WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())$p$, t || '_all', t);
    END IF;
  END LOOP;
END $$;
