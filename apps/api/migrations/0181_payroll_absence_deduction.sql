-- 0181: loss of pay from attendance (R3).
--
-- Until now payroll deducted only APPROVED unpaid leave; days the attendance evaluation marks `absent` (and repeated late
-- arrivals) never reached payroll. Two effective-dated settings, off by default so no tenant's pay changes until HR opts in:
--   absence_deduction_mode   'off'          = as before (default)
--                            'absent_days'  = each absent day (and half a day for a half_day result) is deducted at the
--                                             same daily rate as unpaid leave
--   late_marks_per_absence   NULL = late arrivals are never deducted; N = every N late marks (late / late-and-early days)
--                            count as one absent day (a common Pakistani workplace rule: "3 lates = 1 day")
ALTER TABLE payroll_settings
  ADD COLUMN IF NOT EXISTS absence_deduction_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS late_marks_per_absence integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_settings_absence_mode_ck') THEN
    ALTER TABLE payroll_settings ADD CONSTRAINT payroll_settings_absence_mode_ck CHECK (absence_deduction_mode IN ('off', 'absent_days'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_settings_late_marks_ck') THEN
    ALTER TABLE payroll_settings ADD CONSTRAINT payroll_settings_late_marks_ck CHECK (late_marks_per_absence IS NULL OR late_marks_per_absence BETWEEN 2 AND 31);
  END IF;
END $$;

-- The payslip keeps the days it deducted for absence, so reports and the payslip view can show them.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS absent_days numeric(6,2) NOT NULL DEFAULT 0;

-- A component result can now come from attendance.
ALTER TABLE payroll_component_results DROP CONSTRAINT IF EXISTS payroll_component_results_source_type_check;
ALTER TABLE payroll_component_results ADD CONSTRAINT payroll_component_results_source_type_check CHECK (source_type IN
  ('compensation', 'overtime', 'additional_payment', 'off_cycle_payment', 'loan', 'leave', 'statutory', 'tax', 'override', 'rounding', 'retro', 'attendance'));
