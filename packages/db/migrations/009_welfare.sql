-- Gig-worker welfare contribution (LEGAL L-02, L-03; working assumption D-089): charged to the
-- business on top of the shift cost, never deducted from worker pay. Rates are policies
-- (welfare.central_bp, welfare.state_bp per state) and default to 0 until a lawyer confirms them.

-- Rates frozen on each timesheet when it is created, like fee_bp / gst_bp.
ALTER TABLE timesheets ADD COLUMN welfare_central_bp int NOT NULL DEFAULT 0 CHECK (welfare_central_bp >= 0);
ALTER TABLE timesheets ADD COLUMN welfare_state_bp int NOT NULL DEFAULT 0 CHECK (welfare_state_bp >= 0);
ALTER TABLE timesheets ADD COLUMN welfare_state text;

ALTER TABLE overtime_requests ADD COLUMN welfare_paise bigint NOT NULL DEFAULT 0 CHECK (welfare_paise >= 0);

-- Invoices: welfare is collected for remittance, not our revenue, so it is not GST-taxable (to confirm, L-12).
ALTER TABLE invoices ADD COLUMN pass_through_paise bigint NOT NULL DEFAULT 0 CHECK (pass_through_paise >= 0);
ALTER TABLE invoices DROP CONSTRAINT invoices_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_total CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + pass_through_paise);
