-- Phase 2: business verification, sites, wage rates, shifts, worker onboarding, bookings, waitlist,
-- funding (mock escrow), ledger, webhooks, fraud flags.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- reference data

CREATE TABLE cities (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  state_code  text NOT NULL,          -- ISO 3166-2:IN suffix, e.g. KA
  wage_zone   text NOT NULL,
  center      geography(Point, 4326) NOT NULL,
  radius_km   int NOT NULL DEFAULT 50
);

CREATE TABLE skills (
  code              text PRIMARY KEY,
  name_i18n         jsonb NOT NULL,
  min_wage_category text NOT NULL DEFAULT 'unskilled' CHECK (min_wage_category IN ('unskilled', 'semi_skilled', 'skilled'))
);

CREATE TABLE role_categories (
  code           text PRIMARY KEY,
  name_i18n      jsonb NOT NULL,
  wage_category  text NOT NULL CHECK (wage_category IN ('unskilled', 'semi_skilled', 'skilled')),
  hazard_level   text NOT NULL DEFAULT 'low' CHECK (hazard_level IN ('low', 'medium', 'high')),
  allowed_skills text[] NOT NULL DEFAULT '{}',
  active         boolean NOT NULL DEFAULT true
);

-- Versioned minimum wage table. Amounts are frozen after insert; only the approval status moves.
CREATE TABLE min_wage_rates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code             text NOT NULL,
  wage_category          text NOT NULL CHECK (wage_category IN ('unskilled', 'semi_skilled', 'skilled')),
  zone                   text NOT NULL,
  basic_paise_per_day    bigint NOT NULL CHECK (basic_paise_per_day > 0),
  vda_paise_per_day      bigint NOT NULL DEFAULT 0 CHECK (vda_paise_per_day >= 0),
  standard_hours_per_day int NOT NULL DEFAULT 8 CHECK (standard_hours_per_day BETWEEN 1 AND 12),
  effective_from         date NOT NULL,
  source_ref             text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  created_by             uuid REFERENCES staff_users(id),
  approved_by            uuid REFERENCES staff_users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE INDEX min_wage_lookup ON min_wage_rates (state_code, wage_category, zone, effective_from DESC) WHERE status = 'active';

CREATE FUNCTION min_wage_rates_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'min_wage_rates rows cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.state_code, NEW.wage_category, NEW.zone, NEW.basic_paise_per_day, NEW.vda_paise_per_day,
      NEW.standard_hours_per_day, NEW.effective_from, NEW.source_ref, NEW.created_by)
     IS DISTINCT FROM
     (OLD.state_code, OLD.wage_category, OLD.zone, OLD.basic_paise_per_day, OLD.vda_paise_per_day,
      OLD.standard_hours_per_day, OLD.effective_from, OLD.source_ref, OLD.created_by) THEN
    RAISE EXCEPTION 'min_wage_rates amounts are frozen; add a new version instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'min_wage_rates status already decided' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER min_wage_rates_frozen BEFORE UPDATE OR DELETE ON min_wage_rates FOR EACH ROW EXECUTE FUNCTION min_wage_rates_freeze();

-- Policy changes go through a second approver before becoming a new policy_config version.
CREATE TABLE policy_change_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL,
  scope          text NOT NULL DEFAULT 'global',
  value          jsonb NOT NULL,
  effective_from timestamptz NOT NULL,
  reason         text NOT NULL,
  requested_by   uuid NOT NULL REFERENCES staff_users(id),
  decided_by     uuid REFERENCES staff_users(id),
  decision       text CHECK (decision IN ('approved', 'rejected')),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- ---------------------------------------------------------------- businesses and sites

ALTER TABLE businesses
  ADD COLUMN gstin               text CHECK (gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN gst_legal_name      text,
  ADD COLUMN gstin_checked_at    timestamptz,
  ADD COLUMN pan_hash            text,
  ADD COLUMN pan_last4           text,
  ADD COLUMN udyam_or_se_no      text,
  ADD COLUMN signatory_name      text,
  ADD COLUMN risk_tier           text NOT NULL DEFAULT 'new' CHECK (risk_tier IN ('new', 'standard', 'high')),
  ADD COLUMN risk_reasons        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN submitted_at        timestamptz,
  ADD COLUMN verified_at         timestamptz,
  ADD COLUMN decision_reason     text,
  ADD COLUMN review_round        int NOT NULL DEFAULT 0;
-- One live business per GSTIN (BIZ-04).
CREATE UNIQUE INDEX businesses_gstin_unique ON businesses (gstin) WHERE gstin IS NOT NULL AND verification_status <> 'rejected';

CREATE TABLE business_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  staff_id    uuid NOT NULL REFERENCES staff_users(id),
  round       int NOT NULL,
  decision    text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, staff_id, round)
);

CREATE TABLE sites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  name          text NOT NULL,
  address       text NOT NULL,
  city_code     text NOT NULL REFERENCES cities(code),
  state_code    text NOT NULL,
  wage_zone     text NOT NULL,
  location      geography(Point, 4326) NOT NULL,
  geofence_m    int NOT NULL DEFAULT 150 CHECK (geofence_m BETWEEN 50 AND 2000),
  status        text NOT NULL DEFAULT 'pending_verify' CHECK (status IN ('pending_verify', 'active', 'paused', 'rejected')),
  status_reason text,
  verified_by   uuid REFERENCES staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_location ON sites USING gist (location);
CREATE INDEX sites_by_business ON sites (business_id);
CREATE TRIGGER sites_updated BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- shifts

CREATE TABLE shifts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses(id),
  site_id                uuid NOT NULL REFERENCES sites(id),
  role_code              text NOT NULL REFERENCES role_categories(code),
  title                  text NOT NULL,
  description            text NOT NULL DEFAULT '',
  starts_at              timestamptz NOT NULL,
  ends_at                timestamptz NOT NULL,
  break_minutes          int NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 120),
  headcount              int NOT NULL CHECK (headcount BETWEEN 1 AND 500),
  filled_count           int NOT NULL DEFAULT 0,
  pay_type               text NOT NULL CHECK (pay_type IN ('hourly', 'per_shift')),
  pay_paise              bigint NOT NULL CHECK (pay_paise > 0),
  meal_allowance_paise   bigint NOT NULL DEFAULT 0 CHECK (meal_allowance_paise >= 0),
  travel_allowance_paise bigint NOT NULL DEFAULT 0 CHECK (travel_allowance_paise >= 0),
  requirements           jsonb NOT NULL DEFAULT '{}',
  dress_code             text NOT NULL DEFAULT '',
  bring_items            text NOT NULL DEFAULT '',
  onsite_contact_member_id uuid REFERENCES business_members(id),
  wage_category          text NOT NULL,
  min_wage_rate_id       uuid NOT NULL REFERENCES min_wage_rates(id),
  cost                   jsonb NOT NULL,
  total_paise            bigint NOT NULL CHECK (total_paise > 0),
  status                 text NOT NULL CHECK (status IN ('pending_review', 'pending_funding', 'live', 'cancelled', 'completed')),
  review_reasons         text[] NOT NULL DEFAULT '{}',
  reviewed_by            uuid REFERENCES staff_users(id),
  created_by             uuid NOT NULL REFERENCES users(id),
  published_at           timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '12 hours'),
  CHECK (filled_count BETWEEN 0 AND headcount)  -- the last line of defence against overbooking (SYS-01)
);
CREATE INDEX shifts_live ON shifts (starts_at) WHERE status = 'live';
CREATE INDEX shifts_by_business ON shifts (business_id, starts_at DESC);
CREATE TRIGGER shifts_updated BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE gender_requirements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id     uuid NOT NULL UNIQUE REFERENCES shifts(id),
  requirement  text NOT NULL CHECK (requirement IN ('female', 'male')),
  legal_reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by   uuid REFERENCES staff_users(id),
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- workers

CREATE TABLE worker_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  first_name          text,
  legal_name_enc      text,
  name_norm_hash      text,
  dob_year            int,
  age_verified_at     timestamptz,
  kyc_status          text NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none', 'verified', 'rejected', 'review')),
  kyc_method          text,
  kyc_ref_hash        text,
  kyc_reject_reason   text,
  face_embedding      vector(64),
  face_enrolled_at    timestamptz,
  last_liveness_at    timestamptz,
  languages           text[] NOT NULL DEFAULT '{}',
  skills              text[] NOT NULL DEFAULT '{}',
  travel_radius_km    int NOT NULL DEFAULT 10 CHECK (travel_radius_km BETWEEN 1 AND 50),
  has_two_wheeler     boolean NOT NULL DEFAULT false,
  availability        jsonb NOT NULL DEFAULT '{}',
  home_city           text REFERENCES cities(code),
  home_point          geography(Point, 4326),
  profile_completed_at timestamptz,
  verification_status text NOT NULL DEFAULT 'incomplete' CHECK (verification_status IN ('incomplete', 'verified', 'review', 'rejected')),
  completed_shifts    int NOT NULL DEFAULT 0,
  reliability_score   int NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- One verified identity, one account (WRK-01, WRK-07).
CREATE UNIQUE INDEX worker_kyc_ref_unique ON worker_profiles (kyc_ref_hash) WHERE kyc_ref_hash IS NOT NULL;
CREATE INDEX worker_face ON worker_profiles USING hnsw (face_embedding vector_cosine_ops);
CREATE TRIGGER worker_profiles_updated BEFORE UPDATE ON worker_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payout_methods (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        uuid NOT NULL REFERENCES users(id),
  type             text NOT NULL CHECK (type IN ('upi', 'bank')),
  vpa_enc          text,
  account_no_enc   text,
  ifsc             text CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_hash     text NOT NULL,
  display          text NOT NULL,
  name_at_bank_enc text,
  name_match_score int,
  status           text NOT NULL CHECK (status IN ('verified', 'review', 'rejected', 'replaced')),
  verified_at      timestamptz,
  cooldown_until   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_methods_by_hash ON payout_methods (account_hash) WHERE status IN ('verified', 'review');
-- At most one current method per worker.
CREATE UNIQUE INDEX payout_methods_current ON payout_methods (worker_id) WHERE status IN ('verified', 'review');

-- ---------------------------------------------------------------- bookings and waitlist

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id            uuid NOT NULL REFERENCES shifts(id),
  worker_id           uuid NOT NULL REFERENCES users(id),
  status              text NOT NULL CHECK (status IN ('confirmed', 'cancelled_worker', 'cancelled_business', 'no_show', 'checked_in', 'completed', 'turned_away')),
  source              text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'waitlist')),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  -- Shift time padded by half the rest gap on each side; overlapping windows = not enough rest.
  slot_window         tstzrange NOT NULL,
  confirmed_attendance boolean,
  cancelled_at        timestamptz,
  cancel_hours_before numeric(6,2),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (worker_id WITH =, slot_window WITH &&) WHERE (status IN ('confirmed', 'checked_in'))
);
CREATE UNIQUE INDEX bookings_one_active_per_shift ON bookings (shift_id, worker_id) WHERE status IN ('confirmed', 'checked_in', 'completed');
CREATE INDEX bookings_by_worker ON bookings (worker_id, starts_at);
CREATE INDEX bookings_by_shift ON bookings (shift_id);
CREATE TRIGGER bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE waitlist_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id         uuid NOT NULL REFERENCES shifts(id),
  worker_id        uuid NOT NULL REFERENCES users(id),
  position         bigserial,
  status           text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'accepted', 'declined', 'expired', 'left')),
  offered_at       timestamptz,
  offer_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, worker_id)
);
CREATE INDEX waitlist_queue ON waitlist_entries (shift_id, position) WHERE status = 'waiting';
CREATE INDEX waitlist_offers ON waitlist_entries (offer_expires_at) WHERE status = 'offered';

-- ---------------------------------------------------------------- money

CREATE TABLE payment_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  shift_id        uuid NOT NULL REFERENCES shifts(id),
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  provider        text NOT NULL,
  provider_ref    text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'captured', 'failed')),
  idempotency_key text NOT NULL UNIQUE,
  captured_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Only one successful funding per shift.
CREATE UNIQUE INDEX payment_intents_one_capture ON payment_intents (shift_id) WHERE status = 'captured';

CREATE TABLE webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome      text,
  UNIQUE (provider, event_id)
);

-- Double-entry ledger. Every journal's entries sum to zero; nothing is ever updated or deleted.
CREATE TABLE ledger_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,      -- e.g. business_escrow:<uuid>, provider_clearing:mockpay
  type       text NOT NULL,
  owner_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('fund', 'fee', 'payout', 'refund', 'compensation', 'chargeback', 'reversal', 'adjustment')),
  ref_type        text NOT NULL,
  ref_id          text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  memo            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  journal_id   uuid NOT NULL REFERENCES journals(id),
  account_id   uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_paise bigint NOT NULL CHECK (amount_paise <> 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_by_account ON ledger_entries (account_id);
CREATE INDEX ledger_entries_by_journal ON ledger_entries (journal_id);

CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(sum(amount_paise), 0) INTO total FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal % does not balance (off by % paise)', NEW.journal_id, total USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Checked at COMMIT, after all of a journal's entries are in.
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();

-- ---------------------------------------------------------------- trust

CREATE TABLE fraud_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('worker', 'business', 'shift', 'device', 'payout_method')),
  subject_id   text NOT NULL,
  rule_code    text NOT NULL,
  score        int NOT NULL DEFAULT 50,
  evidence     jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  reviewer     uuid REFERENCES staff_users(id),
  review_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX fraud_flags_open ON fraud_flags (created_at DESC) WHERE status = 'open';
CREATE UNIQUE INDEX fraud_flags_dedupe ON fraud_flags (subject_type, subject_id, rule_code) WHERE status = 'open';

-- ---------------------------------------------------------------- mock providers (dev and tests only)

CREATE TABLE mock_kyc_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  persona     jsonb,                 -- set when the tester "approves" on the mock DigiLocker screen
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mock_gstn_registry (
  gstin      text PRIMARY KEY,
  legal_name text NOT NULL,
  status     text NOT NULL DEFAULT 'active'
);
