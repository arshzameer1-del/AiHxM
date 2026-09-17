-- Phase 12 (Compensation & Payroll) surfaced a real Phase 9 gap: the
-- plan doc's own exit criterion for this phase names "an unpaid-leave
-- deduction using Phase 9's real leave data" as a required edge case, but
-- Phase 9's `leave_type` set (`annual` | `casual` | `sick`) has no
-- concept of unpaid leave at all — every existing type draws against a
-- real, bounded entitlement. Rather than fabricate a deduction from data
-- that doesn't exist, this migration extends `leave_requests.leave_type`
-- to also accept `'unpaid'` — see Decision #14 and
-- `LeaveRequestsService.submit()`'s own comment for why `unpaid` is
-- deliberately excluded from `LEAVE_TYPE_TO_POLICY_COLUMN`, policy
-- resolution, and balance tracking entirely: it has no entitlement to
-- draw down, so there is nothing to check or decrement, only a real
-- approved-and-unpaid day for payroll to later find and deduct against.
--
-- `leave_balances.leave_type`'s own CHECK is deliberately left
-- untouched — an 'unpaid' balance row should never exist, and the
-- unmodified constraint is what guarantees that at the database level,
-- not just by convention in application code.
ALTER TABLE leave_requests
  DROP CONSTRAINT leave_requests_leave_type_check,
  ADD CONSTRAINT leave_requests_leave_type_check
    CHECK (leave_type IN ('annual', 'casual', 'sick', 'unpaid'));
