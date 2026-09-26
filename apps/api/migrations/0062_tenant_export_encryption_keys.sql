-- Phase 3 item #5 — Encryption & Secrets (advanced): tenant-dedicated
-- export encryption key with independent rotation.
--
-- The roadmap's original wording for this item was "customer-managed
-- keys, key escrow, HSM-backed rotation, cryptographic policy
-- versioning" — genuine HSM/external-KMS integration (AWS KMS, Azure Key
-- Vault, GCP KMS) is explicitly OUT of scope here: this platform has no
-- such integration and there is no current customer demand signal to
-- justify building one from scratch. Same discipline Phase 2 item #7
-- already applied when it renamed "regional admin" to "scoped admin"
-- because the schema had no real geographic-region concept — build the
-- honest version of the idea, not a fake dressed-up one.
--
-- What this table actually holds is a genuine per-tenant *envelope
-- encryption* key — the same pattern real cloud KMS products (AWS KMS
-- included) use under the hood: `wrapped_key` is a fresh, random 32-byte
-- AES-256 key that has itself been encrypted (AES-256-GCM) under the
-- platform's own EXPORT_ENCRYPTION_KEY server key — see
-- export-crypto.ts's `wrapTenantKey`/`unwrapTenantKey`, reused rather
-- than a second wrapping scheme invented here. The unwrapped key material
-- is NEVER stored anywhere, never returned by any API response, and never
-- shown in the Platform Admin UI — see TenantExportKeyService's own doc
-- comment for the full design and its honest limits (a compromise of
-- EXPORT_ENCRYPTION_KEY itself can still unwrap every tenant's key; only
-- a true externally-held/HSM-backed key, never present on this server at
-- all, would close that gap — a real, larger, deliberately out-of-scope
-- follow-on).
--
-- The concrete, real security property this DOES buy: a tenant that opts
-- in gets its own export-encryption key, independently rotatable and
-- revocable from every other tenant's — a compromise of one tenant's
-- unwrapped key (leaked in a log line, read out of a compromised
-- process's memory, etc.) has a blast radius of exactly that tenant's
-- exports, not the whole platform's, which sharing one global
-- EXPORT_ENCRYPTION_KEY-derived key across every tenant (the Phase 2
-- item #6 default) cannot offer.
--
-- `previous_wrapped_key` / `previous_key_expires_at` mirror
-- `tenant_integrations.previous_secret_value` / `previous_secret_expires_at`
-- (Phase 1 item #12, migration 0054) exactly: a 7-day grace period so an
-- export encrypted under the OLD tenant key just before a rotation is
-- still decryptable for a week afterward, rather than becoming
-- permanently unreadable the instant a rotation happens.
--
-- Same "platform/service concern, not tenant self-service" gate as
-- `tenant_integrations` itself (0042): only a Platform Admin (enabling,
-- rotating, disabling this on behalf of the tenant) or the service role
-- (DataExportsService resolving the active key at request/download time)
-- ever touches this table.

CREATE TABLE IF NOT EXISTS tenant_export_encryption_keys (
  company_id                 uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled                    boolean NOT NULL DEFAULT false,
  wrapped_key                text NOT NULL,
  previous_wrapped_key       text,
  previous_key_expires_at    timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_export_encryption_keys TO app_role;

ALTER TABLE tenant_export_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_export_encryption_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_export_encryption_keys_all ON tenant_export_encryption_keys FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
