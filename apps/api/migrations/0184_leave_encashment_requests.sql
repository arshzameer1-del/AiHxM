-- Leave encashment request: an employee asks HR to pay out some days of an encashable leave type.
-- HR approves with an amount (suggested from the final-settlement daily-rate settings when those are set). Approving
-- queues a payslip payment (employee_additional_payments) and takes the days off the leave balance through the ledger.
ALTER TABLE employee_service_requests
  ADD COLUMN IF NOT EXISTS leave_type text,
  ADD COLUMN IF NOT EXISTS leave_days numeric(6,2) CHECK (leave_days IS NULL OR leave_days > 0),
  ADD COLUMN IF NOT EXISTS additional_payment_id uuid REFERENCES employee_additional_payments(id) ON DELETE SET NULL;

ALTER TABLE employee_service_requests DROP CONSTRAINT IF EXISTS employee_service_requests_request_kind_check;
ALTER TABLE employee_service_requests ADD CONSTRAINT employee_service_requests_request_kind_check
  CHECK (request_kind IN ('loan', 'salary_advance', 'letter', 'leave_encashment'));

ALTER TABLE employee_service_requests DROP CONSTRAINT IF EXISTS employee_service_requests_shape;
ALTER TABLE employee_service_requests ADD CONSTRAINT employee_service_requests_shape CHECK (
  (request_kind IN ('loan', 'salary_advance') AND amount IS NOT NULL AND letter_type IS NULL)
  OR (request_kind = 'letter' AND letter_type IS NOT NULL AND amount IS NULL AND installments_count IS NULL AND loan_type_id IS NULL)
  OR (request_kind = 'leave_encashment' AND leave_type IS NOT NULL AND leave_days IS NOT NULL AND letter_type IS NULL AND installments_count IS NULL AND loan_type_id IS NULL)
);
