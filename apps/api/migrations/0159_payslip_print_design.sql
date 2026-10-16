-- Payslip print design (Configuration Center). ADDITIVE.
--
--   payslip_print_designs   one row per company: the print design of a paystub (paper, margins, typography,
--                           colours, header and logo, blocks and their order, line formatting, footer, signatures,
--                           watermark) as a JSON document. The API validates it on every save
--                           (packages/shared-types/src/payslip-design.ts); a company with no row uses the built-in
--                           default. `version` counts saves so the audit log and a printed sheet can say which design was used.
--
-- ROLLBACK: DELETE FROM configuration_registry WHERE domain_key = 'payslip_print_design'; DROP TABLE payslip_print_designs.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS payslip_print_designs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  design      jsonb NOT NULL CHECK (jsonb_typeof(design) = 'object'),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by  uuid REFERENCES user_accounts(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payslip_print_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslip_print_designs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payslip_print_designs_all ON payslip_print_designs;
CREATE POLICY payslip_print_designs_all ON payslip_print_designs
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON payslip_print_designs TO app_role;

INSERT INTO configuration_registry (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order, layer, owner_module, is_versioned, show_in_center)
VALUES ('payslip_print_design', 'Payslip print design', 'How a paystub looks when printed or saved as PDF: paper, logo, colours, blocks, footer, signatures and watermark.',
        'payroll.calculate.all', 'payroll.calculate.all', '/app/configuration-center/payslip-design', false, 15, 'domain', 'payroll', true, true)
ON CONFLICT (domain_key) DO NOTHING;
