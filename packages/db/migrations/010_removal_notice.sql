-- Removal notice (LEGAL L-03; Karnataka Platform-based Gig Workers Act 2025): a gig worker is not
-- removed from the platform without written reasons and prior notice (removal.notice_days, 14).
-- Staff issue a notice; a job removes the worker when it falls due unless it is withdrawn first.
-- An "interim hold" (safety only) stops new bookings during the notice but keeps the worker able
-- to sign in, read the reasons and reply. Whether such a hold is allowed is a working assumption (D-091).

CREATE TABLE removal_notices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       uuid NOT NULL REFERENCES users(id),
  reasons         text NOT NULL CHECK (length(reasons) BETWEEN 5 AND 2000),
  notice_days     int NOT NULL CHECK (notice_days >= 0),
  interim_hold    boolean NOT NULL DEFAULT false,
  issued_by       uuid NOT NULL REFERENCES staff_users(id),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  effective_at    timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'effected', 'withdrawn')),
  worker_response text CHECK (length(worker_response) <= 2000),
  responded_at    timestamptz,
  closed_by       uuid REFERENCES staff_users(id),
  closed_at       timestamptz,
  close_reason    text,
  CHECK (effective_at >= issued_at + make_interval(days => notice_days))
);
-- At most one open notice per worker.
CREATE UNIQUE INDEX removal_notices_one_pending ON removal_notices (worker_id) WHERE status = 'pending';
CREATE INDEX removal_notices_due ON removal_notices (effective_at) WHERE status = 'pending';
