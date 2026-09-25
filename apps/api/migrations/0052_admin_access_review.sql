-- Tenant Management gap-fill Phase 1 item #7 — User access review status.
-- A periodic-attestation timestamp per tenant admin: "last reviewed" +
-- who reviewed it, cleared to NULL again whenever the admin's access
-- itself changes (status change, login reset) since a review performed
-- before that change no longer attests to the admin's current state.
-- Lives directly on company_admins (not user_accounts) — this is about
-- reviewing the ADMIN RECORD's access grant, which exists even before a
-- login does, not about anything login/session-specific.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE company_admins ADD COLUMN IF NOT EXISTS last_access_reviewed_at timestamptz;
ALTER TABLE company_admins ADD COLUMN IF NOT EXISTS last_access_reviewed_by text;
