-- HR Administration v2, "then 2" Phase 1 (2026-10-01) — the 13 personal/
-- reference catalog families from
-- `core-employee-configuration-hr-admin-v2-gap-analysis-and-roadmap.md`
-- gap-table item #7, the first slice of the scope kumail asked to
-- complete ("so complete it") after 0090 shipped only `employment_type`
-- and the 19 `lifecycle_reason:*` catalogs.
--
-- Same engine, same discipline as 0090: every one of these is a small,
-- tenant-owned, ordered, soft-deactivatable code/label list, so all 13
-- are registered in `catalog-type-registry.ts` (application code) against
-- the SAME generic `hr_reference_catalog_items` table — no new tables here.
--
-- Of the 13, SIX already have a real, exposed data field today, each
-- currently either a hardcoded CHECK-constrained enum or unconstrained
-- free text:
--   family_relationship_type -> employee_family_members.relationship (CHECK)
--   qualification_type       -> employee_qualifications.qualification_type (CHECK)
--   address_type              -> employee_addresses.address_type (CHECK)
--   contact_type               -> employee_contacts.contact_type (CHECK)
--   document_type              -> employee_documents.document_type (free text)
--   marital_status              -> employees.marital_status (free text)
-- Those 6 get their CHECK dropped (where one exists) below, exactly the
-- way 0090 dropped `employees_employment_type_check` — validation moves to
-- the application layer (HrReferenceCatalogService.validateActiveCode(),
-- wired into each owning service this same phase) so a tenant's own
-- HR Administration edits take effect immediately, with no migration.
--
-- The remaining SEVEN (nationality, language, education_level,
-- institution_type, certification_type, document_category,
-- id_document_type) are registered and seeded here too, so an hr_admin
-- can already see and manage them from the HR Administration screen —
-- but, like several of 0090's own `lifecycle_reason:*` catalogs shipped
-- "seeded and editable, not yet consumed by any transaction," none of
-- these 7 has an existing data field to attach to yet (persons.nationality
-- is the one near-exception: present in the schema, but written by no
-- code path today — no Person UI/API exists, per persons.service.ts's own
-- doc comment). Honestly labeled as such in the registry's `wiredInto`
-- field rather than silently implying they already govern real data.
-- Wiring them to real fields (a Language field, Education's institution
-- type, a Documents vault category, etc.) is genuine, separately-scoped
-- follow-up work, not done speculatively in this pass.

-- ---------------------------------------------------------------------
-- Drop the 4 hardcoded CHECK constraints this phase replaces with
-- application-level catalog validation. Column types and existing data
-- are completely unchanged, matching 0090's own
-- `employees_employment_type_check` precedent exactly.
-- ---------------------------------------------------------------------
ALTER TABLE employee_family_members DROP CONSTRAINT IF EXISTS employee_family_members_relationship_check;
ALTER TABLE employee_qualifications DROP CONSTRAINT IF EXISTS employee_qualifications_qualification_type_check;
ALTER TABLE employee_addresses DROP CONSTRAINT IF EXISTS employee_addresses_address_type_check;
ALTER TABLE employee_contacts DROP CONSTRAINT IF EXISTS employee_contacts_contact_type_check;
-- employee_documents.document_type and employees.marital_status were
-- already unconstrained free text — nothing to drop for either.

-- ---------------------------------------------------------------------
-- Seed data — every existing company gets the same starter set, matching
-- the live values each already-wired catalog's column already contains
-- today, so nothing already stored becomes invalid. The 7 not-yet-wired
-- catalogs get a reasonable Pakistan-SMB-appropriate starter set too, so
-- HR Administration isn't an empty list the day this ships.
-- ---------------------------------------------------------------------
INSERT INTO hr_reference_catalog_items (company_id, catalog_type, code, label, sort_order)
SELECT c.id, seed.catalog_type, seed.code, seed.label, seed.sort_order
FROM companies c
CROSS JOIN (VALUES
  ('family_relationship_type', 'spouse', 'Spouse', 0),
  ('family_relationship_type', 'child', 'Child', 1),
  ('family_relationship_type', 'parent', 'Parent', 2),
  ('family_relationship_type', 'sibling', 'Sibling', 3),
  ('family_relationship_type', 'other', 'Other', 4),

  ('qualification_type', 'certificate', 'Certificate', 0),
  ('qualification_type', 'license', 'License', 1),
  ('qualification_type', 'skill', 'Skill', 2),

  ('address_type', 'permanent', 'Permanent', 0),
  ('address_type', 'current', 'Current', 1),
  ('address_type', 'mailing', 'Mailing', 2),

  ('contact_type', 'business_email', 'Business email', 0),
  ('contact_type', 'personal_email', 'Personal email', 1),
  ('contact_type', 'business_phone', 'Business phone', 2),
  ('contact_type', 'personal_phone', 'Personal phone', 3),
  ('contact_type', 'emergency_contact', 'Emergency contact', 4),

  ('document_type', 'cnic', 'CNIC', 0),
  ('document_type', 'cnic_copy', 'CNIC copy', 1),
  ('document_type', 'passport', 'Passport', 2),
  ('document_type', 'driving_license', 'Driving license', 3),
  ('document_type', 'degree_certificate', 'Degree certificate', 4),
  ('document_type', 'experience_letter', 'Experience letter', 5),
  ('document_type', 'offer_letter', 'Offer letter', 6),
  ('document_type', 'bank_statement', 'Bank statement', 7),
  ('document_type', 'photograph', 'Photograph', 8),
  ('document_type', 'other', 'Other', 9),

  ('marital_status', 'single', 'Single', 0),
  ('marital_status', 'married', 'Married', 1),
  ('marital_status', 'divorced', 'Divorced', 2),
  ('marital_status', 'widowed', 'Widowed', 3),

  ('nationality', 'pk', 'Pakistani', 0),
  ('nationality', 'other', 'Other', 1),

  ('language', 'ur', 'Urdu', 0),
  ('language', 'en', 'English', 1),
  ('language', 'pa', 'Punjabi', 2),
  ('language', 'sd', 'Sindhi', 3),
  ('language', 'ps', 'Pashto', 4),
  ('language', 'other', 'Other', 5),

  ('education_level', 'matric', 'Matriculation', 0),
  ('education_level', 'intermediate', 'Intermediate', 1),
  ('education_level', 'bachelors', 'Bachelors', 2),
  ('education_level', 'masters', 'Masters', 3),
  ('education_level', 'phd', 'PhD', 4),
  ('education_level', 'other', 'Other', 5),

  ('institution_type', 'university', 'University', 0),
  ('institution_type', 'college', 'College', 1),
  ('institution_type', 'vocational', 'Vocational institute', 2),
  ('institution_type', 'online', 'Online platform', 3),
  ('institution_type', 'other', 'Other', 4),

  ('certification_type', 'professional', 'Professional certification', 0),
  ('certification_type', 'vendor', 'Vendor certification', 1),
  ('certification_type', 'compliance', 'Compliance / regulatory', 2),
  ('certification_type', 'other', 'Other', 3),

  ('document_category', 'identity', 'Identity', 0),
  ('document_category', 'educational', 'Educational', 1),
  ('document_category', 'employment', 'Employment', 2),
  ('document_category', 'financial', 'Financial', 3),
  ('document_category', 'other', 'Other', 4),

  ('id_document_type', 'cnic', 'CNIC', 0),
  ('id_document_type', 'nicop', 'NICOP', 1),
  ('id_document_type', 'passport', 'Passport', 2),
  ('id_document_type', 'b_form', 'B-Form', 3)
) AS seed(catalog_type, code, label, sort_order)
ON CONFLICT (company_id, catalog_type, code) DO NOTHING;
