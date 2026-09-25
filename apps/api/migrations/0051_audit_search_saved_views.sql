-- Tenant Management gap-fill Phase 1 item #6 — Audit tab search/filter +
-- saved searches. Extends AuditService.list() with actor/action/date-range
-- filters (code-only change, no schema needed for that half) and reuses
-- the existing `platform_saved_views` table (0042) for audit searches
-- instead of a new table — the row shape (name/filters/created_by) is
-- already exactly what a saved audit search needs.
--
-- The only schema change: a `view_type` discriminator column so a saved
-- view can be a Tenant Directory filter combo OR an Audit Log filter
-- combo without the two colliding in the same list. Every existing row
-- predates this feature and was, by definition, a Tenant Directory view
-- (saved views didn't exist anywhere else until now), so defaulting
-- existing rows to 'tenant_directory' is not a guess — it's simply true.

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

ALTER TABLE platform_saved_views
  ADD COLUMN IF NOT EXISTS view_type text NOT NULL DEFAULT 'tenant_directory';
