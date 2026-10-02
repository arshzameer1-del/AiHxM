-- Expense Management — new ESS module (Part 2 category 6, UI re-skin
-- master doc's own gap list, §3 of
-- claude/ui-reskin-design-system-and-migration-plan-2026-10.md). Confirmed
-- gap: no Expense module existed anywhere in this schema before this
-- migration. Built end-to-end the same way Leave & Attendance (migration
-- 0015/0016, the Phase 9 "real go/no-go checkpoint") was: a new licensed
-- module, a lifecycle object routed through the EXISTING WorkflowService
-- (no second approval center — Part 2's own Global rule), and RBAC
-- permissions granted to the same three real tenant roles every other
-- module uses.
--
-- `category` is a fixed CHECK-constrained set rather than a tenant-
-- configurable reference catalog — a deliberate, documented scope
-- tradeoff (same "don't over-build ahead of actual demand" guardrail
-- leave_type's own three-value CHECK used in 0015) rather than building a
-- full Configuration Center-backed catalog for something not asked for
-- yet. A tenant-configurable category list is a reasonable future
-- addition if real usage asks for it.
--
-- Receipts are their own child table (`expense_claim_receipts`, 1-to-many
-- — Part 2 says "Expense detail includes receipts", plural) rather than a
-- single nullable column on expense_claims, reusing the exact
-- storage_path/mime_type/size_bytes shape `employee_documents`
-- (migration 0010) already established for the same FileStorageService.

-- ---------------------------------------------------------------------
-- expense_claims — the lifecycle object. Same shape/semantics as
-- leave_requests: `workflow_instance_id` links to the approval-routing
-- engine instance (nullable only for the instant between the claim row
-- and its workflow instance both being created — ExpenseClaimsService
-- never leaves it null once submit() commits); `submitted_by_user_account_id`
-- vs the employee's own user_account_id (joined via employee_id)
-- distinguishes an On-Behalf submission, same as leave.
--
-- Status adds 'draft' and 'paid' on top of leave_requests' four values —
-- Part 2 explicitly calls for "draft -> submit -> approval -> payment"
-- states. 'paid' is set by a separate, narrowly-permissioned action
-- (expense_claim.pay.all) once the workflow itself reaches 'approved' —
-- payment execution/disbursement integration is out of scope here (no
-- accounting/banking integration exists yet for this object); this only
-- records that payment happened and who recorded it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_claims (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id                  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  category                     text NOT NULL
                                 CHECK (category IN ('travel', 'meals', 'accommodation', 'office_supplies', 'communication', 'training', 'other')),
  expense_date                 date NOT NULL,
  amount                       numeric(12,2) NOT NULL CHECK (amount > 0),
  currency                     text NOT NULL DEFAULT 'PKR',
  description                  text,
  status                       text NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'paid', 'cancelled')),
  submitted_by_user_account_id uuid REFERENCES user_accounts(id),
  workflow_instance_id         uuid REFERENCES workflow_instances(id),
  paid_at                      timestamptz,
  paid_by_user_account_id      uuid REFERENCES user_accounts(id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CHECK (status != 'paid' OR paid_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_expense_claims_employee ON expense_claims (employee_id);
CREATE INDEX IF NOT EXISTS idx_expense_claims_company_status ON expense_claims (company_id, status);

-- ---------------------------------------------------------------------
-- expense_claim_receipts — one row per uploaded receipt file. Same
-- storage shape as employee_documents (0010_employee_core.sql); the
-- FileStorageService itself is scope-agnostic (save(companyId, scope,
-- fileName, buffer) already takes an arbitrary `scope` string), so this
-- reuses the existing service with scope = the expense claim's own id,
-- no new storage backend needed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_claim_receipts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  expense_claim_id            uuid NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  file_name                   text NOT NULL,
  mime_type                   text NOT NULL,
  size_bytes                  integer NOT NULL,
  storage_path                text NOT NULL,
  uploaded_by_user_account_id uuid REFERENCES user_accounts(id),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_claim_receipts_claim ON expense_claim_receipts (expense_claim_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON expense_claims, expense_claim_receipts TO app_role;

-- Same genuine tenant-scoped-write RLS shape as leave_requests/
-- leave_balances (0015) — real end users write these tables directly.
ALTER TABLE expense_claims          ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claims          FORCE ROW LEVEL SECURITY;
ALTER TABLE expense_claim_receipts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claim_receipts  FORCE ROW LEVEL SECURITY;

CREATE POLICY expense_claims_all ON expense_claims FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

CREATE POLICY expense_claim_receipts_all ON expense_claim_receipts FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- Licensing: register 'expense' as a real module (module_catalog is
-- itself RLS'd — FORCE ROW LEVEL SECURITY applies to this migration
-- connection too, same reasoning as 0006/0016's identical line).
-- Placed in the 'professional'/'enterprise' tiers alongside payroll/bi —
-- same tier band as the other money-adjacent module, not the base
-- starter/growth tiers.
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO module_catalog (key, name, description) VALUES
  ('expense', 'Expense Management', 'Employee expense claims with receipts, centralized approval workflow and reimbursement tracking.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO package_tier_modules (package_tier, module_key) VALUES
  ('professional', 'expense'),
  ('enterprise', 'expense')
ON CONFLICT (package_tier, module_key) DO NOTHING;

-- Backfill: existing professional/enterprise companies get the module
-- entitlement row immediately, same backfill 0006 itself did for its own
-- initial seed — otherwise a company created before this migration ran
-- would be on a tier that now includes 'expense' in its default set, but
-- with no actual tenant_module_entitlement row to turn it on.
INSERT INTO tenant_module_entitlement (company_id, module_key, enabled)
SELECT c.id, 'expense', true
FROM companies c
WHERE c.package_tier IN ('professional', 'enterprise')
ON CONFLICT (company_id, module_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Permissions — same three-role pattern as every module since Phase 4
-- (0016_leave_attendance_seed.sql's own header comment).
-- ---------------------------------------------------------------------
INSERT INTO permissions (key, description) VALUES
  ('expense_claim.view.self',   'View your own expense claims'),
  ('expense_claim.view.team',   'View expense claims of your direct reports'),
  ('expense_claim.view.all',    'View any expense claim in your company'),
  ('expense_claim.create.self', 'Create and submit an expense claim for yourself'),
  ('expense_claim.manage.all',  'Submit an expense claim on behalf of any employee (On-Behalf), and cancel any expense claim'),
  ('expense_claim.pay.all',     'Mark an approved expense claim as paid')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'hr_admin'
  AND p.key IN ('expense_claim.view.all', 'expense_claim.manage.all', 'expense_claim.pay.all')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'line_manager' AND p.key = 'expense_claim.view.team'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.key = 'employee_self_service'
  AND p.key IN ('expense_claim.view.self', 'expense_claim.create.self')
ON CONFLICT DO NOTHING;
