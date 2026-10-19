-- Phase 5: notification outbox (written in the same transaction as the event), user preferences,
-- and attendance confirmations ("I'm coming / I can't come").

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id),
  to_phone_enc    text,                       -- for people who aren't users (e.g. a trusted contact)
  template        text NOT NULL,
  lang            text NOT NULL,
  body_enc        text NOT NULL,              -- rendered text, encrypted (it can contain links or amounts)
  critical        boolean NOT NULL DEFAULT false,
  channel         text CHECK (channel IN ('sms', 'whatsapp')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  provider        text,
  provider_ref    text,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  dedupe_key      text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CHECK (user_id IS NOT NULL OR to_phone_enc IS NOT NULL)
);
CREATE INDEX notifications_due ON notifications (next_attempt_at) WHERE status = 'queued';
CREATE INDEX notifications_by_user ON notifications (user_id, created_at DESC);

ALTER TABLE users ADD COLUMN whatsapp_opt_in_at timestamptz;
ALTER TABLE users ADD COLUMN reminders_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN attendance_answered_at timestamptz;
