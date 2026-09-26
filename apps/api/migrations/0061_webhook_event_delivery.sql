-- Phase 3 item #4 — Webhooks & Eventing: real outbound webhook delivery.
-- `tenant_integrations`' `webhook` provider row (migration 0042) has had a
-- `signingSecret` (rotatable, migration 0054) since Phase 1, but nothing
-- ever actually SENT a webhook — this migration is the queue/log table
-- that finally does. Deliberately proportionate scope, per the roadmap's
-- own note: this is a fixed, backend-defined set of event types
-- (WebhookDispatchService.enqueue() callers), delivered to the ONE
-- target URL a tenant configures on its `webhook` integration row
-- (`tenant_integrations.config.url` — the same field key the Integrations
-- tab's config form already had sitting unused since that provider was
-- first built, rather than inventing a second, differently-named field
-- for the same concept). No schema registry, no tenant-authored event
-- subscriptions, no per-event-type target URLs — the "full Segment/
-- Zapier-grade event bus" the roadmap explicitly says to avoid.
--
-- Delivery model (WebhookDispatchService):
--   - `enqueue()` inserts a `pending` row. A tenant with no `webhook`
--     integration enabled, or none configured, silently gets no row at
--     all (checked at enqueue time) rather than a row that can never
--     succeed.
--   - A 1-minute @Cron sweep (same shape as CompaniesLifecycleScheduler's
--     hourly sweep, migration 0042/companies.module.ts — no job queue in
--     this codebase, see that scheduler's own doc comment) selects due
--     `pending`/`failed` rows and POSTs the JSON payload, HMAC-SHA256
--     signed with the tenant's `signingSecret`.
--   - Exponential backoff on failure, capped at 5 attempts:
--       attempt 1 -> retry after  1 minute
--       attempt 2 -> retry after  5 minutes
--       attempt 3 -> retry after 30 minutes
--       attempt 4 -> retry after  2 hours
--       attempt 5 -> retry after 12 hours
--     A 5th failed attempt moves the row to `dead_letter` instead of
--     scheduling a 6th — see WebhookDispatchService.BACKOFF_SCHEDULE_MS,
--     the one place this schedule is defined; this comment mirrors it,
--     not the other way around.
--   - `dead_letter` (and `failed`, before it exhausts attempts) can be
--     manually replayed by a Platform Admin, which resets attempt_count
--     to 0 and next_attempt_at to now() so the next sweep tick picks it
--     straight back up.
--
-- Same "platform/service concern, not tenant self-service" gate as
-- `tenant_integrations` itself (0042) and `scim_provisioned_users` (0060):
-- only a Platform Admin (viewing/replaying deliveries) or the cron
-- sweep/enqueue call path (`is_service`) ever touches this table.

CREATE TABLE IF NOT EXISTS webhook_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type            text NOT NULL,
  payload               jsonb NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempt_count         integer NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  last_error            text,
  last_response_status  integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz
);

-- Delivery-log listing: most recent first, scoped to one tenant.
CREATE INDEX IF NOT EXISTS idx_webhook_events_company_created
  ON webhook_events (company_id, created_at DESC);

-- What the cron sweep actually selects on — a partial index so it stays
-- small and fast regardless of how many `delivered`/`dead_letter` rows
-- pile up over time (those are never re-scanned by the sweep).
CREATE INDEX IF NOT EXISTS idx_webhook_events_due
  ON webhook_events (next_attempt_at)
  WHERE status IN ('pending', 'failed');

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_events TO app_role;

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_events_all ON webhook_events FOR ALL
  USING (app.is_platform_admin() OR app.is_service())
  WITH CHECK (app.is_platform_admin() OR app.is_service());
