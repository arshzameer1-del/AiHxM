-- 0182: reimburse an approved expense claim through payroll (functional gap 4).
--
-- Approved claims used to be marked "paid" by hand, outside payroll. Now HR can queue a claim for the next payroll: that creates
-- a non-taxable additional payment (the existing mechanism payroll already reads), remembered on both sides. When the payroll run
-- that consumes the payment is finalised, the claim becomes "paid" automatically.
ALTER TABLE employee_additional_payments
  ADD COLUMN IF NOT EXISTS expense_claim_id uuid REFERENCES expense_claims(id) ON DELETE SET NULL;
ALTER TABLE expense_claims
  ADD COLUMN IF NOT EXISTS payroll_payment_id uuid REFERENCES employee_additional_payments(id) ON DELETE SET NULL;
-- a claim can be queued only once at a time (a cancelled payment frees it again)
CREATE UNIQUE INDEX IF NOT EXISTS uq_additional_payment_one_per_claim
  ON employee_additional_payments (expense_claim_id)
  WHERE expense_claim_id IS NOT NULL AND status IN ('pending', 'consumed');
CREATE INDEX IF NOT EXISTS idx_expense_claims_payroll_payment ON expense_claims (payroll_payment_id) WHERE payroll_payment_id IS NOT NULL;
