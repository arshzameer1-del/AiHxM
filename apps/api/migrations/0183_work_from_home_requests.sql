-- Work-from-home requests share the on-duty request table, workflow and
-- permissions: only the kind differs. Existing rows stay 'on_duty'.
ALTER TABLE on_duty_requests
  ADD COLUMN IF NOT EXISTS duty_type text NOT NULL DEFAULT 'on_duty'
  CHECK (duty_type IN ('on_duty', 'work_from_home'));
