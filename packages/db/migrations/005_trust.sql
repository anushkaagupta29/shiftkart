-- Phase 4: cancellations and compensation, strikes and appeals, ratings, chat, disputes,
-- safety (SOS, incidents, trusted contacts), blocks, conversion to full-time, staff read tracking.

-- ---------------------------------------------------------------- cancellations

ALTER TABLE shifts ADD COLUMN cancelled_by text CHECK (cancelled_by IN ('business', 'ops', 'site_paused'));
ALTER TABLE shifts ADD COLUMN night_transport_attested boolean NOT NULL DEFAULT false;
ALTER TABLE shifts ADD COLUMN is_night boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN night_consent_at timestamptz;
ALTER TABLE bookings ADD COLUMN turned_away_at timestamptz;
ALTER TABLE bookings ADD COLUMN turn_away_reason text;

ALTER TABLE payouts DROP CONSTRAINT payouts_kind_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_kind_check CHECK (kind IN ('wage', 'dispute_award', 'manual', 'compensation'));
ALTER TABLE payouts ADD COLUMN booking_id uuid REFERENCES bookings(id);

CREATE TABLE compensations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL UNIQUE REFERENCES bookings(id),
  shift_id     uuid NOT NULL REFERENCES shifts(id),
  worker_id    uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (reason IN ('late_cancel', 'turned_away', 'site_paused')),
  hours_before numeric(7,2),
  rule         jsonb NOT NULL,       -- which policy window applied, for the explanation shown to both sides
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER compensations_append_only BEFORE UPDATE OR DELETE ON compensations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- strikes and appeals

ALTER TABLE worker_profiles ADD COLUMN limited_until timestamptz;
ALTER TABLE worker_profiles ADD COLUMN trusted_contact_name text;
ALTER TABLE worker_profiles ADD COLUMN trusted_contact_phone_enc text;

CREATE TABLE strikes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       uuid NOT NULL REFERENCES users(id),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  kind            text NOT NULL CHECK (kind IN ('late_cancel', 'no_show')),
  points          int NOT NULL CHECK (points > 0),
  status          text NOT NULL CHECK (status IN ('active', 'excused', 'appealed', 'overturned', 'upheld')),
  emergency       boolean NOT NULL DEFAULT false,
  hours_before    numeric(7,2),
  expires_at      timestamptz NOT NULL,
  appeal_reason   text,
  appealed_at     timestamptz,
  decision_reason text,
  decided_by      uuid REFERENCES staff_users(id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, kind)
);
CREATE INDEX strikes_by_worker ON strikes (worker_id, created_at DESC);

-- ---------------------------------------------------------------- ratings

CREATE TABLE ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  rater_type  text NOT NULL CHECK (rater_type IN ('worker', 'business')),
  rater_id    uuid NOT NULL,         -- user id (worker) or business id
  ratee_type  text NOT NULL CHECK (ratee_type IN ('worker', 'business')),
  ratee_id    uuid NOT NULL,
  stars       int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags        text[] NOT NULL DEFAULT '{}',
  comment     text NOT NULL DEFAULT '',
  revealed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, rater_type)
);
CREATE INDEX ratings_by_ratee ON ratings (ratee_type, ratee_id) WHERE revealed_at IS NOT NULL;
CREATE INDEX ratings_by_rater ON ratings (rater_type, rater_id);
CREATE TRIGGER ratings_append_only BEFORE DELETE ON ratings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- chat, calls, blocks

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL UNIQUE REFERENCES bookings(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  worker_id   uuid NOT NULL REFERENCES users(id),
  closes_at   timestamptz NOT NULL,
  closed_reason text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sender_type     text NOT NULL CHECK (sender_type IN ('worker', 'business', 'system')),
  sender_id       uuid,
  body            text NOT NULL,   -- what the recipient sees (phone numbers already masked)
  original_enc    text,            -- what was typed, encrypted, kept only when we changed or blocked it (for review)
  flags           text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL CHECK (status IN ('delivered', 'blocked', 'hidden')),
  reported_at     timestamptz,
  report_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_by_conversation ON messages (conversation_id, created_at);

CREATE TABLE call_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  requested_by    text NOT NULL,
  virtual_number  text NOT NULL,
  pin             text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_blocks (
  worker_id   uuid NOT NULL REFERENCES users(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, business_id)
);

-- ---------------------------------------------------------------- disputes

CREATE TABLE dispute_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('timesheet', 'cancellation', 'payment', 'rating', 'conduct', 'other')),
  booking_id       uuid REFERENCES bookings(id),
  timesheet_id     uuid UNIQUE REFERENCES timesheets(id),
  business_id      uuid NOT NULL REFERENCES businesses(id),
  worker_id        uuid NOT NULL REFERENCES users(id),
  opened_by        text NOT NULL CHECK (opened_by IN ('worker', 'business', 'ops')),
  summary          text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'decided', 'withdrawn')),
  assignee         uuid REFERENCES staff_users(id),
  ack_due_at       timestamptz NOT NULL,
  decide_due_at    timestamptz NOT NULL,
  acknowledged_at  timestamptz,
  decision         text,
  decision_reason  text,
  decided_by       uuid REFERENCES staff_users(id),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_cases_open ON dispute_cases (decide_due_at) WHERE status IN ('open', 'under_review');
CREATE TRIGGER dispute_cases_updated BEFORE UPDATE ON dispute_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Timeline shown to both sides. Append-only.
CREATE TABLE dispute_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES dispute_cases(id),
  actor_type text NOT NULL CHECK (actor_type IN ('worker', 'business', 'ops', 'system')),
  actor_id   uuid,
  type       text NOT NULL CHECK (type IN ('opened', 'statement', 'evidence', 'acknowledged', 'decision', 'withdrawn', 'note')),
  body       text NOT NULL,
  internal   boolean NOT NULL DEFAULT false,   -- ops-only notes are never shown to either side
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_events_by_case ON dispute_events (case_id, created_at);
CREATE TRIGGER dispute_events_append_only BEFORE UPDATE OR DELETE ON dispute_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- safety

CREATE TABLE sos_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        uuid NOT NULL REFERENCES users(id),
  booking_id       uuid REFERENCES bookings(id),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  share_token_hash text UNIQUE,
  share_expires_at timestamptz,
  acknowledged_by  uuid REFERENCES staff_users(id),
  acknowledged_at  timestamptz,
  resolved_by      uuid REFERENCES staff_users(id),
  resolved_at      timestamptz,
  resolution       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sos_locations (
  id      bigserial PRIMARY KEY,
  sos_id  uuid NOT NULL REFERENCES sos_events(id),
  lat     double precision NOT NULL,
  lng     double precision NOT NULL,
  accuracy_m int,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sos_locations_by_sos ON sos_locations (sos_id, at DESC);

CREATE TABLE incidents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_type text NOT NULL CHECK (reporter_type IN ('worker', 'business', 'anonymous')),
  reporter_id  uuid,                 -- always NULL for anonymous reports
  category     text NOT NULL CHECK (category IN ('harassment', 'unsafe_site', 'injury', 'payment_demand', 'discrimination', 'work_mismatch', 'underage_worker', 'other')),
  business_id  uuid REFERENCES businesses(id),
  site_id      uuid REFERENCES sites(id),
  booking_id   uuid REFERENCES bookings(id),
  description  text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('low', 'high', 'critical')),
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'closed')),
  assigned_to  uuid REFERENCES staff_users(id),
  outcome      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_type <> 'anonymous' OR reporter_id IS NULL)
);
CREATE INDEX incidents_open ON incidents (created_at DESC) WHERE status <> 'closed';
CREATE TRIGGER incidents_updated BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- conversion to full-time (OFF-01)

CREATE TABLE hire_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  worker_id       uuid NOT NULL REFERENCES users(id),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  role_title      text NOT NULL,
  monthly_salary_paise bigint,
  message         text NOT NULL DEFAULT '',
  fee_paise       bigint NOT NULL,
  gst_paise       bigint NOT NULL,
  status          text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'paid', 'withdrawn')),
  payment_intent_id uuid REFERENCES payment_intents(id),
  worker_responded_at timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hire_requests_open ON hire_requests (business_id, worker_id) WHERE status IN ('offered', 'accepted');

ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_purpose_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK (purpose IN ('shift', 'overtime', 'conversion'));
ALTER TABLE payment_intents ADD COLUMN hire_request_id uuid REFERENCES hire_requests(id);
ALTER TABLE payment_intents ALTER COLUMN shift_id DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN shift_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN hire_request_id uuid UNIQUE REFERENCES hire_requests(id);

-- ---------------------------------------------------------------- staff read tracking (INT-05)

CREATE TABLE staff_reads (
  id        bigserial PRIMARY KEY,
  staff_id  uuid NOT NULL REFERENCES staff_users(id),
  resource  text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_reads_by_staff ON staff_reads (staff_id, at DESC);

ALTER TABLE fraud_flags DROP CONSTRAINT fraud_flags_subject_type_check;
ALTER TABLE fraud_flags ADD CONSTRAINT fraud_flags_subject_type_check
  CHECK (subject_type IN ('worker', 'business', 'shift', 'device', 'payout_method', 'system', 'staff'));
