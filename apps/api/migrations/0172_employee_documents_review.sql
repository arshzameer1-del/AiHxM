-- 0172_employee_documents_review.sql
-- BACKLOG50: the document vault gets what HR needs to actually run on it.
--   * expiry_date / note on every document (contracts, work permits, certificates expire),
--   * employee self-upload: a document an employee uploads is 'pending' until HR approves or rejects it,
--   * the mandatory documents (HR Administration > Business Policies > Document Policy, `requiredDocumentTypes`) now drive an
--     on-file / waiting / missing / expired checklist on every employee - no second list is kept.
-- Documents that already exist (and everything HR uploads) are 'approved'.

ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS expiry_date date;
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'approved';
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS reviewed_by_user_account_id uuid;
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE employee_documents ADD COLUMN IF NOT EXISTS review_note text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_documents_review_status_check') THEN
    ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_review_status_check
      CHECK (review_status IN ('approved', 'pending', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_documents_pending ON employee_documents (company_id, created_at) WHERE review_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_employee_documents_expiry ON employee_documents (company_id, expiry_date) WHERE expiry_date IS NOT NULL;

-- HR reviews a pending document: the status columns are updated in place.
DROP POLICY IF EXISTS employee_documents_update ON employee_documents;
CREATE POLICY employee_documents_update ON employee_documents FOR UPDATE
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
GRANT UPDATE ON employee_documents TO app_role;
