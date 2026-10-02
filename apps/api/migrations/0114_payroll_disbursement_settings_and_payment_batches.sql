-- Payroll Enterprise Gap Analysis, Phase P5 (claude/payroll-enterprise-
-- gap-analysis-and-roadmap.md): "Payments & accounting integration."
--
-- TWO CHANGES, both scoped exactly to this phase's own stated goal — a
-- real bank file + duplicate-payment protection. The larger Section 19/20/21
-- scope (payment release workflow, GL journals, a formal reconciliation
-- control center) is explicitly Phase P6 ("only if/when tenant size
-- warrants it"), not built here.
--
-- 1. `payroll_disbursement_settings` — ONE non-effective-dated row per
--    company, holding the ORDERED column list `generateDisbursementFile()`
--    emits. This is deliberately a tenant-configurable "swappable adapter"
--    (development-plan.md Section 6, WRICEF "Interfaces": "bank
--    disbursement file export ... built as swappable adapters per tenant,
--    since one client's bank export format is not another's") rather than
--    a hardcoded specific bank's real file spec — this codebase has no
--    primary-source confirmation of any one Pakistani bank's actual bulk-
--    upload column layout, and the file's own header doc comment already
--    refuses to presume a statutory/format detail it can't verify (same
--    posture as the EOBI/tax-slab defaults). NOT effective-dated like
--    `payroll_settings`/`tax_slabs` — this is an EXPORT FORMAT preference,
--    never a payroll calculation input a historical run needs pinned to
--    its own period.
CREATE TABLE IF NOT EXISTS payroll_disbursement_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Ordered array of field keys from DISBURSEMENT_FIELD_KEYS
  -- (payroll.service.ts) — e.g. ["employeeNumber","accountTitle",
  -- "accountNumber","iban","netPay"]. Defaults to the 3 columns
  -- generateDisbursementFile() always produced before this phase, so an
  -- existing tenant's bank file is byte-identical until they explicitly
  -- reconfigure it.
  columns     jsonb NOT NULL DEFAULT '["employeeNumber", "bankAccountNumber", "netPay"]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON payroll_disbursement_settings TO app_role;
ALTER TABLE payroll_disbursement_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_disbursement_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_disbursement_settings_select ON payroll_disbursement_settings FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY payroll_disbursement_settings_insert ON payroll_disbursement_settings FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY payroll_disbursement_settings_update ON payroll_disbursement_settings FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- 2. `payroll_payment_batches` — duplicate-payment protection (Section 19:
--    "duplicate-payment prevention" / "rejected-payment handling / reissue-
--    retry controls"; Section 21's Payment/Bank reconciliation rows).
--    `generateDisbursementFile()` writes one row here EVERY time it
--    actually produces a file, and — before writing a SECOND one for the
--    same run — requires the caller to pass `confirmRegenerate: true`,
--    so a stray second click (or a second person downloading the same
--    file) can never silently hand someone a second bank file for money
--    that may already have been transferred. `status` moves
--    'generated' -> 'voided' only via `voidPaymentBatch()`, an explicit,
--    reasoned, audited action (e.g. "bank rejected the file") — never a
--    bare delete, so the history this table exists to provide is never
--    lost.
CREATE TABLE IF NOT EXISTS payroll_payment_batches (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id                uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  batch_reference                text NOT NULL,
  row_count                     integer NOT NULL,
  excluded_count                integer NOT NULL DEFAULT 0,
  total_net_pay                 numeric(14,2) NOT NULL,
  status                        text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'voided')),
  voided_reason                 text,
  voided_at                     timestamptz,
  voided_by_user_account_id     uuid REFERENCES user_accounts(id),
  generated_by_user_account_id  uuid NOT NULL REFERENCES user_accounts(id),
  generated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_payment_batches_company ON payroll_payment_batches (company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payment_batches_run ON payroll_payment_batches (payroll_run_id, generated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_payment_batches_reference ON payroll_payment_batches (company_id, batch_reference);

GRANT SELECT, INSERT, UPDATE ON payroll_payment_batches TO app_role;
ALTER TABLE payroll_payment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payment_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_payment_batches_select ON payroll_payment_batches FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY payroll_payment_batches_insert ON payroll_payment_batches FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY payroll_payment_batches_update ON payroll_payment_batches FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
