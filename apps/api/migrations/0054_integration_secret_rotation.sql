-- Tenant Management gap-fill Phase 1 item #12 — API key/webhook secret
-- rotation with an old-key grace period. Scoped to the two integration
-- providers where AIHXM itself ISSUES the credential (`biometric_device`'s
-- apiKey, `webhook`'s signingSecret — a value the tenant's device/endpoint
-- must be told, that we can freely regenerate) rather than smtp/sso, whose
-- secrets are issued BY the external system and can't be "rotated" from
-- this side at all. `previous_secret_value` and `previous_secret_expires_at`
-- hold exactly one prior secret value plus when it stops being honored —
-- one column each is enough since a provider only ever has one secret
-- field (see integrations.service.ts's SECRET_FIELDS map) and only one
-- rotation is ever in flight at a time (a second Rotate before the first
-- grace period ends simply overwrites it, same as re-saving any other
-- field does elsewhere in this codebase).

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE tenant_integrations ADD COLUMN IF NOT EXISTS previous_secret_value text;
ALTER TABLE tenant_integrations ADD COLUMN IF NOT EXISTS previous_secret_expires_at timestamptz;
