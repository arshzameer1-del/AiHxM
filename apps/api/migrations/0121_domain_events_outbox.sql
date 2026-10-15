-- Gap Register PLT-04 (Step 1): transactional outbox + subscriptions.
--
-- `webhook_events` (0061) is a per-tenant HTTP delivery queue — it is not an
-- outbox. This adds the real thing, additively (webhook_events untouched):
--
--   domain_events        one immutable row per business fact, written in the
--                        SAME transaction as the change it describes
--                        (event_id, aggregate_type/id, aggregate_version,
--                        payload, correlation/causation ids, occurred_at).
--                        Payloads are redacted by DomainEventsService before
--                        insert (SEC-13: no CNIC / bank / salary values).
--   event_subscriptions  MANY per tenant (tenant_integrations allowed one):
--                        event-type patterns, target, status, versioned
--                        signing secret (secret_version; the secret itself
--                        is stored only as ciphertext once SEC-03 lands —
--                        column is nullable until then).
--   event_deliveries     one row per (event, subscription): attempts,
--                        next_attempt_at (exponential backoff), last error,
--                        dead_lettered flag; replay re-queues a delivery by
--                        the ORIGINAL event id (never a new event).
--
-- domain_events are append-only (trigger below). Deliveries/subscriptions are
-- operational and updatable. A dispatcher worker built on background_jobs
-- (0120) consumes event_deliveries in a later work package; this migration
-- + DomainEventsService provide the durable contract.
--
-- ROLLBACK: DROP TABLE event_deliveries, event_subscriptions, domain_events;
--           DROP FUNCTION app.domain_events_append_only();

SELECT set_config('request.jwt.claims', '{"is_service": true}', false);

CREATE TABLE IF NOT EXISTS domain_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- dot-namespaced, e.g. 'employee.hired', 'payroll.run.finalized'
  event_type         text NOT NULL,
  schema_version     int  NOT NULL DEFAULT 1,
  aggregate_type     text NOT NULL,
  aggregate_id       text NOT NULL,
  aggregate_version  int,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id     uuid,
  causation_id       uuid,
  actor              text,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_domain_events_company_time ON domain_events (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate ON domain_events (company_id, aggregate_type, aggregate_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_domain_events_type ON domain_events (company_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_events_correlation ON domain_events (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             text NOT NULL,
  -- exact types or trailing-wildcard patterns: 'employee.*', 'payroll.run.finalized'
  event_patterns   text[] NOT NULL,
  target_kind      text NOT NULL DEFAULT 'webhook' CHECK (target_kind IN ('webhook', 'internal')),
  target_url       text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  secret_version   int  NOT NULL DEFAULT 1,
  -- ciphertext only; populated once envelope encryption (SEC-03) exists
  signing_secret_encrypted text,
  max_attempts     int  NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CONSTRAINT event_subscriptions_webhook_has_url CHECK (target_kind <> 'webhook' OR target_url IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS event_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempt_count    int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status_code int,
  last_error       text,
  dead_lettered    boolean NOT NULL DEFAULT false,
  replay_count     int NOT NULL DEFAULT 0,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, subscription_id),
  CONSTRAINT event_deliveries_dead_letter_only_when_failed CHECK (NOT dead_lettered OR status = 'failed')
);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_due ON event_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_event_deliveries_subscription ON event_deliveries (subscription_id, status);

-- domain_events are immutable facts.
CREATE OR REPLACE FUNCTION app.domain_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Allow the cascade from deleting the owning company/tenant; block direct edits.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'domain_events is append-only: % is not permitted', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS domain_events_append_only ON domain_events;
CREATE TRIGGER domain_events_append_only
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION app.domain_events_append_only();

GRANT SELECT, INSERT ON domain_events TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_subscriptions, event_deliveries TO app_role;

ALTER TABLE domain_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE event_subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_subscriptions  FORCE ROW LEVEL SECURITY;
ALTER TABLE event_deliveries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_deliveries     FORCE ROW LEVEL SECURITY;

CREATE POLICY domain_events_select ON domain_events FOR SELECT
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY domain_events_insert ON domain_events FOR INSERT
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY event_subscriptions_all ON event_subscriptions FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
CREATE POLICY event_deliveries_all ON event_deliveries FOR ALL
  USING (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id())
  WITH CHECK (app.is_platform_admin() OR app.is_service() OR company_id = app.current_company_id());
