-- 0194 - leave ledger: one deduction per approved request, not one per leave type per year.
-- The idempotency key of an approval deduction was the constant "approved", and the unique index is
-- (employee, type, year, entry type, source type, source key), so only the FIRST approved leave of a type in a year was ever deducted;
-- later ones were silently skipped (ON CONFLICT DO NOTHING). Compensatory-off credits had the same flaw ("comp_off").
-- The ledger is append-only, so existing rows keep their old key; new entries use a key that names the request. This posts the deductions
-- that were skipped (approved requests with no deduction at all) and re-derives the balance rows.
-- Idempotent: re-running changes nothing.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO leave_ledger (company_id, employee_id, leave_type, year, entry_type, days, effective_date, source_type, source_id, source_key, reason)
SELECT r.company_id, r.employee_id, r.leave_type, EXTRACT(YEAR FROM r.start_date)::int, 'deduction',
       -COALESCE(r.balance_units, r.days_requested), r.updated_at::date, 'leave_request', r.id, 'approved:' || r.id::text,
       'Approved leave that an earlier ledger key had skipped'
  FROM leave_requests r
  JOIN leave_types lt ON lt.company_id = r.company_id AND lt.code = r.leave_type AND lt.tracks_balance
 WHERE r.status = 'approved'
   AND COALESCE(r.balance_units, r.days_requested) > 0
   AND NOT EXISTS (SELECT 1 FROM leave_ledger l WHERE l.source_type = 'leave_request' AND l.source_id = r.id AND l.entry_type = 'deduction')
ON CONFLICT DO NOTHING;

-- re-derive the summary rows for every balance whose ledger now differs
UPDATE leave_balances b SET
  used_days = x.used, entitled_days = x.entitled, updated_at = now()
FROM (
  SELECT employee_id, leave_type, year,
         -COALESCE(SUM(days) FILTER (WHERE entry_type IN ('deduction','reversal')), 0) AS used,
         COALESCE(SUM(days) FILTER (WHERE entry_type IN ('opening','accrual','carry_forward','adjustment','encashment','expiry')), 0) AS entitled
    FROM leave_ledger GROUP BY employee_id, leave_type, year
) x
WHERE b.employee_id = x.employee_id AND b.leave_type = x.leave_type AND b.year = x.year
  AND (b.used_days IS DISTINCT FROM x.used OR b.entitled_days IS DISTINCT FROM x.entitled);
