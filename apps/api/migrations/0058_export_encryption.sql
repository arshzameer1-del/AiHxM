-- ---------------------------------------------------------------------
-- Phase 2 gap-fill item #6 — export encryption/expiry/password-protection.
-- Expiry already existed and was already real (DataExportsService's own
-- EXPORT_TTL_HOURS, enforced server-side in download()) — this migration
-- closes the other honest gap that service's own header comment used to
-- flag: "no at-rest encryption layer to hang a real 'encrypted' claim on
-- yet." The encryption itself needs no new columns — every stored export
-- file becomes a self-describing AES-256-GCM envelope (see
-- export-crypto.ts), so the only thing the database needs to remember is
-- WHETHER a download password is required, never the password itself
-- (never stored anywhere, not even hashed — same guarantee as a real
-- password-protected zip file).
-- ---------------------------------------------------------------------

ALTER TABLE tenant_data_exports
  ADD COLUMN IF NOT EXISTS is_password_protected boolean NOT NULL DEFAULT false;
