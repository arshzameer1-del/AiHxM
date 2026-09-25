-- Tenant Management gap-fill batch 1, Phase 1 item #5 — deletion impact
-- preview + second-approver rule.
--
-- requestDeletion() (TM-037/038, migration 0042) already locks a tenant
-- immediately and schedules an automatic purge after a grace period —
-- proportionate for a small/empty tenant, but letting a single Platform
-- Admin single-handedly schedule irreversible archival of a tenant that
-- actually has real employee data on it is a real governance gap for
-- anything above a meaningful size. Above
-- CompaniesService.SECOND_APPROVAL_EMPLOYEE_THRESHOLD active employees,
-- a deletion request now still locks the tenant immediately (unchanged —
-- a tenant pending deletion has no business staying reachable either
-- way), but deliberately does NOT set deletion_purge_at yet: a DIFFERENT
-- Platform Admin (self-approval is rejected in CompaniesService) must
-- call the new approve-deletion endpoint before the grace-period clock
-- actually starts. deletion_grace_days holds the grace period chosen at
-- request time so it can still be applied once approved, without asking
-- the approver to re-enter it.
--
-- All four columns nullable/defaulted so every pre-existing company row
-- (and every deletion request already in flight) reads back cleanly —
-- deletion_approval_required defaults to false, meaning "behaves exactly
-- as before" for anything that predates this migration.
SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_approval_required boolean NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_grace_days integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_approved_by text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_approved_at timestamptz;
