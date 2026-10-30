-- FORMCFG3: the Form settings screen (/app/configuration-center/form-settings) had no card in the Configuration Center,
-- so it could only be opened by typing its address. This adds the card, next to Employee numbering.
-- ROLLBACK: DELETE FROM configuration_registry WHERE domain_key = 'form_settings';
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

INSERT INTO configuration_registry (domain_key, label, description, manage_permission, view_permission, admin_route, supports_effective_dating, sort_order, layer, owner_module, is_versioned, show_in_center)
VALUES ('form_settings', 'Form settings', 'Rename a field, add help text, make it required, hide it or limit its length on the employee record, leave, travel and help desk forms.',
        'employee.manage.all', 'employee.manage.all', '/app/configuration-center/form-settings', false, 16, 'configuration', 'employee', true, true)
ON CONFLICT (domain_key) DO NOTHING;
