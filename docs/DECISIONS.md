# Decisions log

Short notes on choices and assumptions. **A** = assumed without asking (owner said "everything default"), **Q** = owner answered.

| ID | Date | Decision | Why | Type |
|---|---|---|---|---|
| D-001 | 2026-10-19 | Built as a personal/learning project; no registered company. All external services stay mocked; sandbox needs vendor accounts later (ask first). | Owner: "doing this as a project" | Q |
| D-002 | 2026-10-19 | Marketplace model (business engages worker; we charge a fee), with invoicing and statutory lines abstracted so an employer-of-record model is possible later. | Simplest default; legal review needed | A |
| D-003 | 2026-10-19 | Launch region Bengaluru, Karnataka. Languages: Hindi, English, Kannada. | Large warehouse/retail/event demand. Karnataka also has its own gig-worker law, which is a good test of configurable rules. | A |
| D-004 | 2026-10-19 | Launch roles: warehouse packing/loading, retail floor/billing, event setup/staff. | Highest surge demand, low skill barrier | A |
| D-005 | 2026-10-19 | Fee 15% of worker pay + 18% GST on fee, configurable. | Placeholder | A |
| D-006 | 2026-10-19 | Mocks first for every external provider, behind adapter interfaces. Vendor comparison later. | Owner default; no company yet | Q |
| D-007 | 2026-10-19 | Stack: TypeScript monorepo (pnpm workspaces), Fastify API, Drizzle + Postgres 16 with PostGIS and pgvector, pg-boss queues, Next.js (business, admin), Expo (worker), Vitest, Playwright, Docker Compose. | One language, one database, few moving parts | A |
| D-008 | 2026-10-19 | Eventual hosting: AWS Mumbai. Not used yet. | Data localisation | A |
| D-009 | 2026-10-19 | Android only. Worker app also built for web so Playwright can E2E-test it without emulators. | Owner default | A |
| D-010 | 2026-10-19 | No referral or incentive payouts in v1. Full-time conversion fee is included (business-paid). | Largest collusion surface | A |
| D-011 | 2026-10-19 | Policy numbers in SPEC §6.7, plus: 12h approval window, 30s QR rotation, 150m geofence, rest gap 8h, cap 12h/day and 60h/week (overtime included), 2× overtime. All are configurable placeholders. | Need real values from law/lawyer | A |
| D-012 | 2026-10-19 | Grievance officer: placeholder in the app until a real person is named. | No company yet | A |
| D-013 | 2026-10-19 | Name stays "ShiftKart" as working name; trademark check is on the legal checklist. | Owner default | A |
| D-014 | 2026-10-19 | Project lives at `~/Desktop/shiftkart`, local git only, no remote. | Owner default | A |
| D-015 | 2026-10-19 | Overlap prevention via a Postgres EXCLUDE constraint; last-slot safety via an atomic conditional UPDATE. No app-level locks. | Database guarantees survive bugs and multiple API instances | A |
| D-016 | 2026-10-19 | Workers are never charged and never clawed back. Chargeback losses are absorbed by the platform and recovered from the business. | Core trust promise | A |
| D-017 | 2026-10-19 | ~~pnpm via corepack~~ → **npm workspaces**. Node 26 no longer ships corepack, and npm needs no global install. | Permissions rule (no global installs) | A |
| D-018 | 2026-10-19 | Store birth year only, never full DOB or any Aadhaar digits. Discard the KYC photo after deriving the face embedding. | Data minimisation | A |
| D-019 | 2026-10-19 | Plain SQL migrations + a tiny runner, and `pg` with handwritten SQL, instead of Drizzle (amends D-007). | Triggers, exclusion constraints and money/locking logic are clearer and safer in SQL; no schema duplication | A |
| D-020 | 2026-10-19 | Opaque random session tokens stored hashed (not JWTs). Access 15 min, rotating refresh 30 days with reuse detection. | Instant revocation (suspension, removed members) without a blocklist | A |
| D-021 | 2026-10-19 | Staff auth: email + password (scrypt) + TOTP 2FA, HttpOnly SameSite=Strict cookie, 8 h sessions, lockout after 5 failures, TOTP codes single-use. Separate token type from users, so a user token can never reach /admin. | Insider and account-takeover risk | A |
| D-022 | 2026-10-19 | Deny by default: a route without an auth rule fails startup. A test walks every route × every role. | Auth on every endpoint, not in the UI | A |
| D-023 | 2026-10-19 | Audit log is append-only (DB trigger) and hash-chained (tamper-evident). Admin writes require a reason. Phone reveals are audited. | INT-01, INT-02 | A |
| D-024 | 2026-10-19 | Personal data in URLs avoided: phone search and the dev outbox use POST bodies. Logs are redacted by path and by regex (catches phones/emails in error messages). | Privacy rule; MSG-06 | A |
| D-025 | 2026-10-19 | One account per phone, and a phone is either a worker or a business user, not both. | Simplifies self-dealing checks (MON-01) | A |
| D-026 | 2026-10-19 | Upgraded to Vitest 5 and Next.js 16 at setup, since npm audit flagged the older majors (dev-tooling advisories). `npm audit` now reports 0. | Fresh project; cheapest time to move | A |
| D-027 | 2026-10-19 | Local Postgres on port 5433, bound to 127.0.0.1 only, with a throwaway password in docker-compose. | Avoid clashing with any installed Postgres; local only | A |
| D-028 | 2026-10-19 | Playwright E2E deferred to Phase 2 (when the business web and worker app exist). It downloads browsers, so I'll ask first. Phase 1 UI was checked by hand in the browser. | Permissions rule; little UI to cover yet | A |
