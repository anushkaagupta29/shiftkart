-- Phase 1: identity, sessions, staff, businesses (minimal), policy config, audit log.
-- Conventions: uuid ids, timestamptz in UTC, money as bigint paise, encrypted columns end in _enc,
-- keyed lookup hashes end in _hash.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;

-- Workers and business-side people. One account per phone number.
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_enc      text NOT NULL,
  phone_hash     text NOT NULL UNIQUE,
  phone_last4    text NOT NULL CHECK (phone_last4 ~ '^\d{4}$'),
  kind           text NOT NULL CHECK (kind IN ('worker', 'business')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'limited', 'suspended', 'deleted')),
  preferred_lang text NOT NULL DEFAULT 'en' CHECK (preferred_lang IN ('en', 'hi', 'kn')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  device_id_hash text NOT NULL,
  platform       text NOT NULL DEFAULT 'unknown',
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id_hash)
);
CREATE INDEX devices_by_hash ON devices (device_id_hash);

CREATE TABLE consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  purpose      text NOT NULL,
  version      text NOT NULL,
  lang         text NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE INDEX consents_by_user ON consents (user_id);

CREATE TABLE otp_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash  text NOT NULL,
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  locked_at   timestamptz
);
CREATE INDEX otp_by_phone ON otp_requests (phone_hash, created_at DESC);
CREATE INDEX otp_by_ip ON otp_requests (ip, created_at DESC);

-- Each refresh rotates into a new row in the same family. Reusing a rotated refresh token revokes the family.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  device_id          uuid REFERENCES devices(id),
  family_id          uuid NOT NULL,
  access_hash        text NOT NULL UNIQUE,
  access_expires_at  timestamptz NOT NULL,
  refresh_hash       text NOT NULL UNIQUE,
  refresh_expires_at timestamptz NOT NULL,
  rotated_at         timestamptz,
  revoked_at         timestamptz,
  revoke_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_by_user ON sessions (user_id);
CREATE INDEX sessions_by_family ON sessions (family_id);

CREATE TABLE staff_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  name            text NOT NULL,
  password_hash   text NOT NULL,
  totp_secret_enc text NOT NULL,
  last_totp_step  bigint NOT NULL DEFAULT 0,
  roles           text[] NOT NULL CHECK (roles <@ ARRAY['ops_support','ops_verifier','ops_disputes','ops_safety','finance','compliance','super_admin']::text[] AND cardinality(roles) > 0),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER staff_users_updated BEFORE UPDATE ON staff_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES staff_users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Businesses: minimal in Phase 1 (verification fields arrive in Phase 2).
CREATE TABLE businesses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name          text NOT NULL,
  trade_name          text,
  verification_status text NOT NULL DEFAULT 'draft'
                        CHECK (verification_status IN ('draft', 'pending', 'verified', 'rejected', 'suspended')),
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER businesses_updated BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner', 'manager', 'supervisor')),
  site_ids    uuid[] NOT NULL DEFAULT '{}',
  added_by    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE UNIQUE INDEX business_members_active ON business_members (business_id, user_id) WHERE removed_at IS NULL;

-- Versioned rule values. Never updated in place: a new row with a later effective_from supersedes.
CREATE TABLE policy_config (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL,
  scope          text NOT NULL DEFAULT 'global',
  value          jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  changed_by     uuid REFERENCES staff_users(id),
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, scope, effective_from)
);
CREATE TRIGGER policy_config_append_only BEFORE UPDATE OR DELETE ON policy_config FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Append-only, hash-chained audit log. hash = sha256(prev_hash || canonical(entry)).
CREATE TABLE audit_log (
  seq          bigserial PRIMARY KEY,
  at           timestamptz NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('staff', 'user', 'system')),
  actor_id     uuid,
  actor_roles  text[] NOT NULL DEFAULT '{}',
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  reason       text,
  before       jsonb,
  after        jsonb,
  ip           text,
  prev_hash    text NOT NULL,
  hash         text NOT NULL UNIQUE
);
CREATE INDEX audit_by_target ON audit_log (target_type, target_id);
CREATE INDEX audit_by_actor ON audit_log (actor_id);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Mock SMS/WhatsApp outbox (dev and tests only; real providers replace this).
CREATE TABLE dev_outbox (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel    text NOT NULL,
  to_hash    text NOT NULL,
  to_masked  text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dev_outbox_by_to ON dev_outbox (to_hash, created_at DESC);
