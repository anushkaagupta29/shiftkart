-- Phase 6: DPDP data rights (export, deletion, consent withdrawal) and retention.

ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD COLUMN deleted_reason text CHECK (deleted_reason IN ('user_request', 'while_restricted'));

-- Phone hashes of deleted accounts, kept for fraud prevention (LEGAL L-19). A voluntary deletion frees
-- the number for a fresh sign-up; a deletion while suspended or limited keeps blocking it, and the
-- profile keeps its KYC identity hash so the same person can't verify again under a new number (WRK-07).
CREATE TABLE deleted_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  phone_hash  text NOT NULL,
  blocks_reregistration boolean NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deleted_identities_phone ON deleted_identities (phone_hash) WHERE blocks_reregistration;

-- Attendance records are append-only, except that retention may blank out location after a year.
CREATE FUNCTION attendance_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'table attendance_events is append-only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.lat IS NULL AND NEW.lng IS NULL AND NEW.accuracy_m IS NULL
     AND to_jsonb(NEW) - '{lat,lng,accuracy_m}'::text[] = to_jsonb(OLD) - '{lat,lng,accuracy_m}'::text[] THEN
    RETURN NEW; -- retention: location removed, everything else unchanged
  END IF;
  RAISE EXCEPTION 'table attendance_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER attendance_events_append_only ON attendance_events;
CREATE TRIGGER attendance_events_append_only BEFORE UPDATE OR DELETE ON attendance_events FOR EACH ROW EXECUTE FUNCTION attendance_events_guard();
GRANT UPDATE (lat, lng, accuracy_m) ON attendance_events TO shiftkart_app;
