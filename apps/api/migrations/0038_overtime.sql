-- Overtime & On-Duty — Part 2 row #13, unblocked now that the Work
-- Schedule & Employee Schedule Assignment Architecture's first increment
-- (0037) shipped a real `WorkScheduleResolutionService`: this was the
-- exact "scheduled-vs-actual comparison" dependency this module was
-- blocked on (see claude/aihxm-master-audit-and-roadmap.md, Part 4, the
-- Work Schedule increment's write-up and its own WS-020/021 rows).
--
-- Scope for this first increment, deliberately bounded the same way
-- every prior extraction this session has been ("rule of three, don't
-- over-build ahead of demand"): a per-company Overtime Policy (rate
-- multipliers for an ordinary working day vs. a scheduled rest day vs. a
-- mandatory holiday, a daily minimum-extra-minutes threshold, and a
-- rounding increment), effective-dated via the shared
-- EffectiveDatingEngine exactly like Tax Slabs (a single open row per
-- company, applyVersionedRow) rather than a fifth hand-rolled copy of
-- that pattern; and Overtime Records — a per-employee, per-date claim
-- computed by comparing a real, already-clocked-out attendance_records
-- row against WorkScheduleResolutionService's resolved schedule for that
-- date, submitted for approval and decided via the same plain RBAC
-- self/team/all mechanism Attendance Corrections (0028) already proved
-- fits a single-decider action better than standing up a Workflow Engine
-- instance for it — the identical reasoning applies here (one manager or
-- HR decides one claim, no multi-step chain).
--
-- Deliberately NOT built this increment: an "On-Duty" (officially
-- authorized off-site work, e.g. a field visit) request type sharing the
-- module's name in the roadmap's own module catalog — that is real,
-- separate scope (a different kind of record with a different lifecycle:
-- authorizing an absence from the ordinary schedule ahead of time, not
-- claiming extra hours after the fact) and is tracked as a named
-- follow-on rather than folded in here just because the two share a
-- product-catalog row name. Also deliberately deferred: any Payroll
-- integration (calculateRun() doesn't read attendance_records at all
-- today — wiring approved overtime into a payroll run's disbursement
-- is real follow-on work once Payroll's own Formula Engine exists to
-- receive it) and any Rules-Engine-backed eligibility layer (e.g.
-- "only non-exempt employees accrue overtime") — every employee is
-- eligible to submit a claim in this increment; a second real consumer
-- defining what an eligibility rule needs is the trigger to add one, the
-- same discipline that kept the Rules Engine's own first two consumers
-- from growing a shared field registry neither of them needed yet.

-- ---------------------------------------------------------------------
-- overtime_policies — effective-dated via the shared EffectiveDatingEngine
-- (single open row per company, the exact same shape Tax Slabs already
-- uses — see 0033/EffectiveDatingEngine.applyVersionedRow). Seeded
-- on-demand by OvertimeService the first time a company sets one,
-- exactly like Tax Slabs' own loadOrSeed pattern, rather than backfilled
-- here — there is no pre-existing overtime data to migrate.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overtime_policies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  daily_threshold_minutes     int NOT NULL DEFAULT 0 CHECK (daily_threshold_minutes >= 0),
  rounding_minutes            int NOT NULL DEFAULT 1 CHECK (rounding_minutes >= 1),
  weekday_rate_multiplier     numeric(4,2) NOT NULL DEFAULT 1.50 CHECK (weekday_rate_multiplier > 0),
  rest_day_rate_multiplier    numeric(4,2) NOT NULL DEFAULT 2.00 CHECK (rest_day_rate_multiplier > 0),
  holiday_rate_multiplier     numeric(4,2) NOT NULL DEFAULT 2.00 CHECK (holiday_rate_multiplier > 0),
  effective_from              date NOT NULL,
  effective_to                date,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_overtime_policies_company
  ON overtime_policies (company_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_policies_one_open
  ON overtime_policies (company_id) WHERE effective_to IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON overtime_policies TO app_role;

ALTER TABLE overtime_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE overtime_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY overtime_policies_all ON overtime_policies FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- overtime_records — one row per submitted overtime claim for one
-- employee on one date. `scheduled_minutes`/`actual_minutes`/
-- `overtime_minutes`/`day_type`/`rate_multiplier` are all SNAPSHOTTED at
-- submission time from WorkScheduleResolutionService + the then-current
-- overtime_policies row — the same "resolve once, store the resolved
-- fact" discipline leave_requests already uses for daysRequested, so a
-- later policy or schedule change never silently rewrites the meaning of
-- an already-decided claim. `attendance_record_id` is nullable with
-- ON DELETE SET NULL (never CASCADE), matching onboarding/offboarding's
-- own template-reference convention — losing the evidentiary link must
-- never silently delete the claim itself. The partial unique index
-- allows a REJECTED claim for a date to be resubmitted (e.g. after
-- correcting the reason or waiting for an attendance correction to land)
-- without permanently blocking that date, while still preventing two
-- simultaneously pending/approved claims for the same employee/date.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overtime_records (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  attendance_record_id          uuid REFERENCES attendance_records(id) ON DELETE SET NULL,
  work_date                     date NOT NULL,
  scheduled_minutes             int NOT NULL CHECK (scheduled_minutes >= 0),
  actual_minutes                int NOT NULL CHECK (actual_minutes >= 0),
  overtime_minutes              int NOT NULL CHECK (overtime_minutes >= 0),
  day_type                      text NOT NULL CHECK (day_type IN ('weekday', 'rest_day', 'holiday')),
  rate_multiplier               numeric(4,2) NOT NULL,
  reason                        text,
  status                        text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  decided_by_user_account_id    uuid REFERENCES user_accounts(id),
  decision_comment              text,
  decided_at                    timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_overtime_records_employee
  ON overtime_records (employee_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_overtime_records_company_status
  ON overtime_records (company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_overtime_records_one_active_per_day
  ON overtime_records (employee_id, work_date) WHERE status IN ('pending', 'approved');

GRANT SELECT, INSERT, UPDATE, DELETE ON overtime_records TO app_role;

ALTER TABLE overtime_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE overtime_records FORCE ROW LEVEL SECURITY;

CREATE POLICY overtime_records_all ON overtime_records FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
