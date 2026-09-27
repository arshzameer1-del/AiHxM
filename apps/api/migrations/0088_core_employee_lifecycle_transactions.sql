-- Core Employee Enterprise, Phase 10 — Explicit Lifecycle Transactions
-- (spec Section 26's Lifecycle Transactions table: Transfer, Promotion,
-- Demotion, Secondment, Acting, Manager Change, Location Change,
-- Termination, Reactivation — Hire/Rehire already exist as of Phase 1/2).
--
-- Until now, `employee_job_history`'s only writer besides the manual
-- `addJobHistory()` endpoint was `EmployeesService.autoRecordJobHistory()`
-- — a field-diff INFERENCE that guesses a single event type
-- (hire/promotion/transfer/salary_change/termination) from whatever
-- changed in a plain `update()` call, in a fixed priority order, so a
-- transfer-and-promotion done in one `update()` call is only ever
-- recorded as "promotion." That inference is NOT removed here — it keeps
-- working exactly as before for every existing caller that just PATCHes
-- fields directly (real, tested behavior: employees.service.spec.ts's own
-- "auto-records job history on hire, transfer, and termination" test).
-- What THIS migration adds is the vocabulary for a NEW, EXPLICIT surface
-- (`EmployeeLifecycleService`, this phase's companion code change) where
-- an HR user performs a NAMED transaction — "Promote this employee",
-- "Second them to Finance until March" — and the system records exactly
-- that fact, not a guess.
--
-- The CHECK constraint is widened (drop + re-add, the standard Postgres
-- pattern for a CHECK IN (...) list) rather than switched to a lookup
-- table — this list is a closed, spec-defined vocabulary
-- (Section 26's own transaction names), not tenant-configurable data, so
-- a CHECK is the right level of ceremony (same choice 0010's own
-- original constraint already made).
ALTER TABLE employee_job_history DROP CONSTRAINT employee_job_history_event_type_check;
ALTER TABLE employee_job_history ADD CONSTRAINT employee_job_history_event_type_check
  CHECK (event_type IN (
    'hire', 'promotion', 'transfer', 'salary_change', 'termination', 'rehire', 'other',
    'demotion', 'secondment', 'acting', 'manager_change', 'location_change', 'reactivation'
  ));

-- Secondment/Acting are temporary by nature (spec Section 26: "Secondment"
-- and "Acting" both name an END date the master instruction's own
-- transaction table calls out) — `employee_job_history` already has
-- `effective_date` as the START; `end_date` is new, nullable, and used by
-- ONLY these two event types (every other event type leaves it NULL).
-- Kept on the same append-only history row rather than a new table: this
-- is one more descriptive fact about the historical event, not a second
-- stateful entity that itself changes over time.
ALTER TABLE employee_job_history ADD COLUMN IF NOT EXISTS end_date date;
ALTER TABLE employee_job_history ADD CONSTRAINT employee_job_history_end_after_effective
  CHECK (end_date IS NULL OR end_date >= effective_date);
