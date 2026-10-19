-- Phase 3: attendance (check-in/out, breaks, presence), timesheets, overtime, payouts, refunds,
-- payslips, invoices, provider-side mock ledger and reconciliation.

-- ---------------------------------------------------------------- sites: per-site secret for rotating QR codes
ALTER TABLE sites ADD COLUMN qr_secret_enc text;

-- ---------------------------------------------------------------- attendance

CREATE TABLE attendance_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           uuid NOT NULL REFERENCES bookings(id),
  worker_id            uuid NOT NULL REFERENCES users(id),
  shift_id             uuid NOT NULL REFERENCES shifts(id),
  type                 text NOT NULL CHECK (type IN ('check_in', 'check_out', 'break_start', 'break_end', 'worker_confirm')),
  mode                 text NOT NULL CHECK (mode IN ('online', 'offline_qr', 'offline_supervisor')),
  status               text NOT NULL CHECK (status IN ('accepted', 'flagged', 'rejected', 'pending_confirmation')),
  occurred_at          timestamptz,           -- what the device says
  received_at          timestamptz NOT NULL DEFAULT now(),
  effective_at         timestamptz NOT NULL,  -- the time we trust (server time, or the QR step for offline events)
  lat                  double precision,
  lng                  double precision,
  accuracy_m           int,
  distance_m           int,
  qr_step              bigint,
  face_score           int,
  liveness_ok          boolean,
  mock_location        boolean,
  integrity_verdict    text,
  supervisor_member_id uuid REFERENCES business_members(id),
  confirms_event_id    uuid REFERENCES attendance_events(id),
  reason               text,
  flags                text[] NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_by_booking ON attendance_events (booking_id, effective_at);
-- One accepted check-in and one check-out per booking; a QR code can't be reused for the same event.
CREATE UNIQUE INDEX attendance_one_checkin ON attendance_events (booking_id, type)
  WHERE type IN ('check_in', 'check_out') AND status <> 'rejected';
CREATE TRIGGER attendance_events_append_only BEFORE UPDATE OR DELETE ON attendance_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Optional location pings during a shift (only with the worker's location consent).
CREATE TABLE attendance_pings (
  id          bigserial PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  at          timestamptz NOT NULL DEFAULT now(),
  inside      boolean NOT NULL,
  distance_m  int NOT NULL,
  accuracy_m  int
);
CREATE INDEX attendance_pings_by_booking ON attendance_pings (booking_id, at DESC);

-- ---------------------------------------------------------------- overtime

CREATE TABLE overtime_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL REFERENCES bookings(id),
  shift_id          uuid NOT NULL REFERENCES shifts(id),
  extra_minutes     int NOT NULL CHECK (extra_minutes BETWEEN 15 AND 240),
  multiplier_bp     int NOT NULL,
  worker_pay_paise  bigint NOT NULL,
  fee_paise         bigint NOT NULL,
  gst_paise         bigint NOT NULL,
  total_paise       bigint NOT NULL,
  status            text NOT NULL DEFAULT 'awaiting_funding'
                      CHECK (status IN ('awaiting_funding', 'awaiting_worker', 'accepted', 'declined', 'expired', 'cancelled')),
  requested_by      uuid NOT NULL REFERENCES users(id),
  worker_responded_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX overtime_one_open ON overtime_requests (booking_id) WHERE status IN ('awaiting_funding', 'awaiting_worker', 'accepted');

ALTER TABLE payment_intents
  ADD COLUMN purpose text NOT NULL DEFAULT 'shift' CHECK (purpose IN ('shift', 'overtime')),
  ADD COLUMN overtime_request_id uuid REFERENCES overtime_requests(id),
  ADD COLUMN refunded_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN chargeback_at timestamptz;
DROP INDEX payment_intents_one_capture;
CREATE UNIQUE INDEX payment_intents_one_capture ON payment_intents (shift_id) WHERE status = 'captured' AND purpose = 'shift';
CREATE UNIQUE INDEX payment_intents_one_ot_capture ON payment_intents (overtime_request_id) WHERE status = 'captured';

-- ---------------------------------------------------------------- timesheets

CREATE TABLE timesheets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid NOT NULL UNIQUE REFERENCES bookings(id),
  shift_id              uuid NOT NULL REFERENCES shifts(id),
  business_id           uuid NOT NULL REFERENCES businesses(id),
  worker_id             uuid NOT NULL REFERENCES users(id),
  started_at            timestamptz NOT NULL,
  ended_at              timestamptz NOT NULL,
  break_minutes         int NOT NULL,
  payable_minutes       int NOT NULL,
  overtime_minutes      int NOT NULL DEFAULT 0,
  base_pay_paise        bigint NOT NULL,
  overtime_pay_paise    bigint NOT NULL DEFAULT 0,
  allowances_paise      bigint NOT NULL,
  gross_paise           bigint NOT NULL,
  fee_bp                int NOT NULL,
  gst_bp                int NOT NULL,
  flags                 text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL CHECK (status IN ('awaiting_confirmation', 'pending_approval', 'approved', 'auto_approved', 'partially_disputed', 'disputed', 'resolved')),
  approval_deadline     timestamptz NOT NULL,
  approved_by           uuid REFERENCES users(id),
  approved_at           timestamptz,
  disputed_minutes      int,
  disputed_paise        bigint,
  dispute_category      text,
  dispute_reason        text,
  disputed_by           uuid REFERENCES users(id),
  disputed_at           timestamptz,
  resolution_minutes    int,
  resolution_reason     text,
  resolved_by           uuid REFERENCES staff_users(id),
  resolution_approved_by uuid REFERENCES staff_users(id),
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_paise = base_pay_paise + overtime_pay_paise + allowances_paise),
  CHECK (disputed_minutes IS NULL OR disputed_minutes BETWEEN 1 AND payable_minutes + overtime_minutes)
);
CREATE INDEX timesheets_by_business ON timesheets (business_id, status);
CREATE INDEX timesheets_deadline ON timesheets (approval_deadline) WHERE status = 'pending_approval';
CREATE TRIGGER timesheets_updated BEFORE UPDATE ON timesheets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- INT-01: the numbers on a timesheet are computed once from attendance and can never be edited.
-- Corrections happen through a dispute resolution, which is a separate, audited record.
CREATE FUNCTION timesheets_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'timesheets cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.booking_id, NEW.started_at, NEW.ended_at, NEW.break_minutes, NEW.payable_minutes, NEW.overtime_minutes,
      NEW.base_pay_paise, NEW.overtime_pay_paise, NEW.allowances_paise, NEW.gross_paise, NEW.fee_bp, NEW.gst_bp)
     IS DISTINCT FROM
     (OLD.booking_id, OLD.started_at, OLD.ended_at, OLD.break_minutes, OLD.payable_minutes, OLD.overtime_minutes,
      OLD.base_pay_paise, OLD.overtime_pay_paise, OLD.allowances_paise, OLD.gross_paise, OLD.fee_bp, OLD.gst_bp) THEN
    RAISE EXCEPTION 'timesheet amounts are frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER timesheets_frozen BEFORE UPDATE OR DELETE ON timesheets FOR EACH ROW EXECUTE FUNCTION timesheets_freeze();

-- ---------------------------------------------------------------- payouts

CREATE TABLE payouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        uuid NOT NULL REFERENCES users(id),
  timesheet_id     uuid REFERENCES timesheets(id),
  kind             text NOT NULL CHECK (kind IN ('wage', 'dispute_award', 'manual')),
  amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
  payout_method_id uuid REFERENCES payout_methods(id),
  status           text NOT NULL CHECK (status IN ('pending_approval', 'queued', 'processing', 'paid', 'failed', 'held', 'reversed', 'rejected')),
  held_reason      text,
  idempotency_key  text NOT NULL UNIQUE,
  provider_ref     text UNIQUE,
  attempt_count    int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  journal_key      text NOT NULL,               -- the approval journal this payout pays out
  requested_by     uuid REFERENCES staff_users(id),
  approved_by      uuid REFERENCES staff_users(id),
  reason           text,
  approved_at      timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX payouts_due ON payouts (next_attempt_at) WHERE status = 'queued';
CREATE INDEX payouts_by_worker ON payouts (worker_id, created_at DESC);
CREATE TRIGGER payouts_updated BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  shift_id          uuid NOT NULL REFERENCES shifts(id),
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  idempotency_key   text NOT NULL UNIQUE,
  provider_ref      text UNIQUE,
  status            text NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- documents

CREATE TABLE doc_counters (
  series  text PRIMARY KEY,   -- e.g. INV/2026-27, PS/2026-10
  last_no int NOT NULL DEFAULT 0
);

CREATE TABLE payslips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL UNIQUE,
  worker_id    uuid NOT NULL REFERENCES users(id),
  payout_id    uuid NOT NULL UNIQUE REFERENCES payouts(id),
  timesheet_id uuid REFERENCES timesheets(id),
  lines        jsonb NOT NULL,
  gross_paise  bigint NOT NULL,
  deductions_paise bigint NOT NULL DEFAULT 0,
  net_paise    bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payslips_append_only BEFORE UPDATE OR DELETE ON payslips FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  business_id   uuid NOT NULL REFERENCES businesses(id),
  shift_id      uuid NOT NULL UNIQUE REFERENCES shifts(id),
  buyer         jsonb NOT NULL,     -- legal name, GSTIN, state at the time of issue
  seller        jsonb NOT NULL,
  lines         jsonb NOT NULL,
  taxable_paise bigint NOT NULL,
  cgst_paise    bigint NOT NULL DEFAULT 0,
  sgst_paise    bigint NOT NULL DEFAULT 0,
  igst_paise    bigint NOT NULL DEFAULT 0,
  total_paise   bigint NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);
CREATE TRIGGER invoices_append_only BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE shifts ADD COLUMN settled_at timestamptz;

-- ---------------------------------------------------------------- mock provider's own books (dev and tests)
-- What the payment provider believes happened. Daily reconciliation compares it with our ledger.

CREATE TABLE mock_provider_ledger (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('capture', 'payout', 'refund', 'chargeback', 'payout_reversal')),
  ref             text NOT NULL,
  idempotency_key text UNIQUE,
  amount_paise    bigint NOT NULL,
  destination     text,
  status          text NOT NULL DEFAULT 'success',
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date       date NOT NULL,
  provider_net_paise bigint NOT NULL,
  ledger_net_paise   bigint NOT NULL,
  diff_paise     bigint NOT NULL,
  status         text NOT NULL CHECK (status IN ('matched', 'mismatch')),
  details        jsonb NOT NULL,
  run_by         uuid REFERENCES staff_users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- System-level flags (e.g. a reconciliation mismatch) that aren't about one user.
ALTER TABLE fraud_flags DROP CONSTRAINT fraud_flags_subject_type_check;
ALTER TABLE fraud_flags ADD CONSTRAINT fraud_flags_subject_type_check
  CHECK (subject_type IN ('worker', 'business', 'shift', 'device', 'payout_method', 'system'));
