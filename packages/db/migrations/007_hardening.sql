-- Phase 6 hardening.
-- 1. A least-privilege role for the running app. In production the API connects as shiftkart_app,
--    which can read and write rows but does not own any table: it cannot TRUNCATE, ALTER, DROP or
--    switch off the append-only triggers. Migrations run as the owner. (Password is set by infra.)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shiftkart_app') THEN
    CREATE ROLE shiftkart_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO shiftkart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shiftkart_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shiftkart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shiftkart_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO shiftkart_app;
-- Records that are never changed after writing: no UPDATE/DELETE at all for the app (triggers are a second wall).
REVOKE UPDATE, DELETE ON audit_log, journals, ledger_entries, attendance_events, payslips, invoices, policy_config,
  compensations, dispute_events FROM shiftkart_app;
REVOKE DELETE ON min_wage_rates, timesheets, ratings, payouts, strikes FROM shiftkart_app;

-- 2. New staff accounts get a one-time password and must change it at first login.
ALTER TABLE staff_users ADD COLUMN password_must_change boolean NOT NULL DEFAULT false;
