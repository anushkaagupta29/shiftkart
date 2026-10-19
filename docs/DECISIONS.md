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
| D-029 | 2026-10-19 | Worker app on Expo SDK 58 / React Native 0.88. React pinned to 19.3.0 across all apps with npm `overrides`, so there's exactly one React copy in the monorepo. | Two React copies break React Native at runtime | A |
| D-030 | 2026-10-19 | Accepted 22 `npm audit` advisories inside Expo's build toolchain (Metro, Expo CLI, code signing). They don't ship in the app; `braces`/`node-forge` have no patched versions, and npm's only "fix" is downgrading to Expo 44. Revisit in the Phase 6 security review. | No safe fix exists today | A |
| D-031 | 2026-10-19 | Sessions per client: business web uses HttpOnly SameSite=Strict cookies (`client: "web"` on login, rotating refresh cookie on `/auth`); the Android app keeps tokens in the Android keystore (SecureStore); the worker app's web build (for testing only) uses sessionStorage. | Keeps tokens out of page JavaScript on the web | A |
| D-032 | 2026-10-19 | Mock providers. KYC: a "DigiLocker" test screen where you pick a persona. Liveness/face: deterministic embeddings per person. Bank: behaviour chosen by what you type ("mismatch", "partial", "invalid"). GSTN: a small registry table. Payments: MockPay with a hosted-checkout stand-in that sends HMAC-signed webhooks. All dev-only routes disappear in production (tested). | Lets every path, including failures, be tried by hand | A |
| D-033 | 2026-10-19 | Face templates are stored in pgvector unencrypted, because similarity search needs them in the clear. They are templates, not photos; KYC photos are never stored. Real vendors may keep templates on their side instead. | Duplicate-face detection (WRK-01) | A |
| D-034 | 2026-10-19 | Keyword screening of shift text (discrimination, fees/deposits, document requests, prohibited work in EN/HI/KN) sends posts to human review instead of auto-rejecting them. | Keyword lists have false positives | A |
| D-035 | 2026-10-19 | Platform fee is charged on worker pay only; allowances pass through without a fee. | Doesn't discourage businesses from giving meal/travel allowances | A |
| D-036 | 2026-10-19 | A waitlist offer holds the freed slot for that worker until it expires (10 min, or 3 min within 6 h of start). Expired offers pass on via a sweep every 30 s inside the API process; this moves to a durable job queue with payouts in Phase 3. | Fair to the person first in line; no slot is lost | A |
| D-037 | 2026-10-19 | Rest gap enforced by the DB exclusion constraint by padding each booking by half the gap on both sides. A later change to the rest-gap policy doesn't re-pad existing bookings. | Race-proof; simple | A |
| D-038 | 2026-10-19 | Every new site is reviewed by ops before shifts can be posted there; geofences over 500 m are marked for approval. | Stops fake or far-off "sites" | A |
| D-039 | 2026-10-19 | Shifts can't be edited after creation. Unfunded ones can be withdrawn; cancelling funded shifts (with worker compensation) is Phase 4. This is also how BIZ-05 (bait-and-switch edits) is prevented for now. | Simplest safe rule | A |
| D-040 | 2026-10-19 | I drafted the Hindi app strings and the Hindi/Kannada names of roles and skills myself. They need review by native speakers before real users see them (planned for Phase 5). | No translator yet | A |
| D-041 | 2026-10-19 | Minimum-wage check fails closed: if no approved rate exists for the state, category and zone on the shift date, posting is refused. | Can't prove the pay is legal otherwise | A |
| D-042 | 2026-10-19 | E2E tests clear the local per-network OTP counters (127.0.0.1 only, local DB only) before each run, since every test login comes from one address. | The real limit (10 codes/hour per network) is correct for production | A |
| D-043 | 2026-10-19 | Worker home location is rounded to about 1 km. Businesses see only a worker's first name and reliability score, never their phone, surname, photo or area. | Data minimisation; BIZ-06 | A |
| D-044 | 2026-10-19 | The accept rate limit (10 attempts a minute per worker) is a code constant, not an editable policy value, since the limiter is configured at startup. | Avoids an admin control that does nothing | A |
| D-045 | 2026-10-19 | Business verification checks GSTIN (with GSTN name match) and PAN; the authorised signatory is a name only for now. Their identity check comes with the real KYC vendor. | Mock-only phase | A |
