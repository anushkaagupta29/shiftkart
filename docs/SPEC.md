# ShiftKart — Product Spec (v0.1, draft for review)

> Working name. Status: **draft, not yet approved**. Anything marked `[CONFIG]` is an admin-configurable value; anything marked `[LEGAL]` is tracked in `LEGAL_CHECKLIST.md`; assumptions are logged in `DECISIONS.md`.

## 1. Problem and scope

Indian businesses need many temporary workers on short notice (festivals, sales events, match days, exhibitions, launches, warehouse surges). Today this runs through contractors and WhatsApp groups, with no verification, late pay and frequent no-shows.

ShiftKart is a marketplace:
- **Businesses** post short, pre-funded shifts.
- **Verified workers** pick shifts, check in and out on site, and get paid within 24 hours of approval.
- **Ops** handles verification, disputes, fraud and safety.

**Launch assumptions** (see DECISIONS D-001 to D-010):

| Item | Assumption |
|---|---|
| Model | Marketplace: the business engages the worker, and ShiftKart charges the business a platform fee `[LEGAL]` |
| Launch region | Bengaluru, Karnataka |
| Launch languages | Hindi, English, Kannada |
| Launch roles | Warehouse packing/loading, retail floor/billing counter, event setup/event staff |
| Fee | 15% of worker pay `[CONFIG]`, plus GST on the fee. Gig-worker welfare contribution on worker pay, paid by the business, rate 0 until confirmed `[CONFIG]` `[LEGAL]` (D-090) |
| Worker fees | **None, ever.** Workers never pay anything. |
| Services | Every external service (KYC, liveness, payments, payouts, SMS/WhatsApp, masked calls) runs behind an adapter with a local mock. Sandbox only after vendor selection, and live only with explicit owner approval. |

**Non-goals for v1:** iOS app, permanent hiring, worker loans or advances, referral bonuses and incentives (deferred until the fraud layer exists), multi-state launch.

## 2. Users and surfaces

| Surface | Users | Tech |
|---|---|---|
| Worker app | Workers | Expo (React Native), Android-first, also built for web for E2E tests (port 8081) |
| Business web | Business owners, managers, site supervisors | Next.js, mobile-responsive (port 3002) |
| Supervisor mode | Site supervisor at the gate | Part of the business web app (PWA, works offline) |
| Admin console | Ops, support, finance, compliance, super-admin | Next.js, separate app and separate auth |
| API | All of the above | Node + Fastify + TypeScript, Zod validation |

### Worker UX principles
- Big tap targets (≥ 48dp) and icon + one-word labels.
- Voice prompts (pre-recorded audio per language) on key screens: onboarding, accept, check-in, payslip.
- Language picker as the very first screen, before login.
- Every money amount shown in ₹, with a matching icon.
- Every flow completes in ≤ 5 screens.
- Works on 2G/3G: small payloads, cached shift list, retry queues.
- A permanent banner reads **"ShiftKart kabhi paise nahi maangta / ShiftKart never asks you for money"**, shown in the user's language.

## 3. Architecture

```
apps/
  api/          Fastify API, background jobs (pg-boss), webhooks
  worker/       Expo app
  business/     Next.js business web + supervisor PWA
  admin/        Next.js admin console
packages/
  db/           SQL migrations, migration runner, seed
  shared/       Zod schemas, money utils (paise), rule engine, i18n strings
  adapters/     Interfaces + mocks: kyc, liveness, facematch, bankverify,
                payments(escrow), payouts, sms, whatsapp, maskedcall, integrity
infra/
  docker-compose.yml   Postgres 16 (+ PostGIS, pgvector), Mailpit, mock-provider server
```

**Key choices**
- **One Postgres database.** Job queues run on Postgres (pg-boss), so there's no Redis.
- **Geofence maths** uses PostGIS.
- **Face-embedding dedup** uses pgvector.
- **External services** are behind adapter interfaces. A single mock-provider server simulates webhooks (payment success or failure, chargebacks, payout reversal) so failure paths can be tested.
- **Times** are stored as `timestamptz` in UTC and rendered in `Asia/Kolkata`.
- **Money** is stored as `bigint` paise. Floats never appear in money code, and a lint rule enforces this.
- **Authorization** runs in API middleware on every route (role + resource ownership). The UI is never trusted.

## 4. Roles and permissions

| Role | Scope | Can | Cannot |
|---|---|---|---|
| `worker` | Self | Profile, browse/accept/cancel, check-in/out, chat, rate, dispute, SOS, data export/delete | See other workers, see businesses' internal data |
| `biz_owner` | Own business | Everything for the business: sites, shifts, funding, members, approvals, disputes, invoices | See workers' phone, bank or KYC data |
| `biz_manager` | Assigned sites | Post and fund shifts (if granted), approve timesheets, chat | Manage members or billing |
| `biz_supervisor` | Assigned sites, the day's shifts | Show rotating QR, view roster, mark offline attendance, approve breaks, report incidents | Post or fund shifts, approve pay, see pay totals (configurable) |
| `ops_support` | Platform | View users (masked), chat support, create tickets | See bank details, unmasked phones or KYC docs; move money |
| `ops_verifier` | Platform | Business and worker verification queues | Move money |
| `ops_disputes` | Platform | Resolve disputes within limits `[CONFIG]` | Change timesheet raw logs; resolve above limit without a second approver |
| `ops_safety` | Platform | SOS, incidents, pause sites | Move money |
| `finance` | Platform | Payout queue, retries, refunds, reconciliation, manual payouts (maker-checker) | Edit bank details; approve their own manual payout |
| `compliance` | Platform | Rate tables, rule config, audit log viewer, gender-requirement approvals | Move money |
| `super_admin` | Platform | Manage staff roles | Bypass audit; act without a reason |

Staff log in with email + password + TOTP 2FA. Sessions expire after 8h. Every admin write needs a free-text `reason`. Sensitive reads (unmasking a phone number, viewing KYC data) are logged too.

## 5. Data model (core tables)

All tables have `id uuid`, `created_at`, `updated_at`. Legend: 🔒 = encrypted at the application layer (AES-256-GCM, envelope key from env/KMS), # = HMAC hash for lookup and dedup.

**Identity and accounts**
- `users`: `id, phone_e164🔒, phone_hash#, role_kind (worker|business|staff), status (active|limited|suspended|deleted), preferred_lang, last_login_at`
- `devices`: `user_id, device_id_hash#, platform, app_version, integrity_verdict, first_seen, last_seen, trusted`
- `sessions`: `user_id, device_id, refresh_token_hash, expires_at, revoked_at`
- `otp_requests`: `phone_hash, code_hash, attempts, expires_at, ip, consumed_at`
- `consents`: `user_id, purpose, version, lang, granted_at, withdrawn_at`

**Workers**
- `worker_profiles`:
  - Identity fields: `user_id, legal_name🔒, name_normalized_hash#, dob_year, age_verified_at, kyc_status, kyc_provider_ref, kyc_method (digilocker|vkyc)`
  - Face and payout fields: `face_ref_embedding (vector, 🔒 at rest via column encryption), liveness_status, payout_method_id`
  - Profile fields: `languages[], skills[], travel_radius_km, has_two_wheeler, availability (jsonb), home_point (geography, coarse to ~500m)`
  - Trust fields: `reliability_score, rating_avg_weighted, strike_points, limited_until, emergency_exceptions_used`
  - **No Aadhaar number (full or partial), no document images, no exact DOB.** Only birth year and the verified-adult flag.
- `payout_methods`: `worker_id, type (upi|bank), vpa🔒 / account_no🔒 + ifsc, account_hash#, name_at_bank🔒, name_match_score, verified_at, status, cooldown_until`

**Businesses**
- `businesses`: `legal_name, trade_name, gstin, gstin_verified_at, pan_hash#, pan_last4, udyam_or_se_no, verification_status (draft|pending|verified|rejected|suspended), risk_tier, signatory_user_id`
- `business_members`: `business_id, user_id, role (owner|manager|supervisor), site_ids[], permissions jsonb`
- `sites`: `business_id, name, address, location (geography point), geofence_m (default 150, max 500 without approval), state_code, wage_zone, status (active|paused|pending_verify), verified_by, paused_reason`
- `site_qr_secrets`: `site_id, secret🔒, rotated_at`. Used for rotating QR codes.

**Rules and rates**
- `min_wage_rates`: `state_code, role_category, skill_level, zone, basic_paise_per_day, vda_paise_per_day, effective_from, effective_to, source_ref, approved_by`. Versioned, never overwritten.
- `policy_config`: `key, value jsonb, scope (global|state|role), effective_from, changed_by, reason`. Covers the cancel windows, compensation, strike thresholds, hour caps, rest gap, fees, GST, TDS and welfare rates.
- `role_categories`: `code, name_i18n, wage_category, allowed_requirements, hazard_level, prohibited (bool)`

**Shifts and bookings**
- `shifts`:
  - Core: `business_id, site_id, role_code, title_i18n, description, starts_at, ends_at, break_minutes, headcount, filled_count`
  - Pay: `pay_type (hourly|per_shift), pay_paise, meal_allowance_paise, travel_allowance_paise`
  - Requirements and logistics: `requirements jsonb, gender_requirement_id?, dress_code, bring_items, onsite_contact_member_id`
  - Status: `status (draft|pending_funding|live|full|in_progress|completed|cancelled), funded_txn_id, cancel_reason, cancelled_at`
  - Constraint: `CHECK (filled_count <= headcount)`
- `gender_requirements`: `shift_id, requirement, legal_reason, requested_by, approved_by, approved_at, status`
- `bookings`:
  - Fields: `shift_id, worker_id, status (confirmed|cancelled_worker|cancelled_business|no_show|checked_in|completed|turned_away), slot_window tstzrange (shift time + rest buffer), confirmed_attendance (null|yes|no), source (direct|waitlist)`
  - Constraint: `UNIQUE(shift_id, worker_id)`
  - Constraint: `EXCLUDE USING gist (worker_id WITH =, slot_window WITH &&) WHERE status IN active`. Prevents overlapping bookings at the database level.
- `waitlist_entries`: `shift_id, worker_id, position, offered_at, offer_expires_at, status`

**Attendance**
- `attendance_events`: `booking_id, type (check_in|check_out|break_start|break_end), occurred_at (device), received_at (server), location, accuracy_m, inside_geofence, qr_token_ok, face_match_score, liveness_ok, mock_location_flag, integrity_verdict, mode (online|offline_qr|offline_supervisor), supervisor_member_id, selfie_object_key🔒, flags[]`. **Append-only.**
- `timesheets`: `booking_id, computed_minutes, break_minutes, overtime_minutes, status (pending_approval|approved|auto_approved|partially_disputed|disputed|resolved), approval_deadline, approved_by, approved_at`
- `overtime_requests`: `booking_id, extra_minutes, rate_multiplier, requested_by, worker_accepted_at, funded_txn_id`

**Money** (double-entry ledger, bigint paise)
- `ledger_accounts`:
  - Types: `business_escrow:<id>`, `worker_payable:<id>`, `platform_revenue`, `gst_payable`, `tds_payable`, `welfare_payable`, `provider_clearing`, `refunds_payable`, `chargeback_loss`
  - Fields: `type, owner_id, currency`
- `ledger_entries`: `journal_id, account_id, amount_paise (signed), created_at`. Every journal sums to 0. Append-only (DB trigger blocks UPDATE/DELETE).
- `journals`: `kind (fund|fee|payout|refund|compensation|chargeback|reversal|adjustment), ref_type, ref_id, idempotency_key UNIQUE, created_by, reason`
- `payment_intents`: `business_id, shift_id, amount_paise, provider, provider_ref UNIQUE, status, idempotency_key UNIQUE`
- `payouts`: `worker_id, booking_id, amount_paise, payout_method_id, provider_ref UNIQUE, status (queued|processing|paid|failed|reversed|held), idempotency_key UNIQUE, attempt_count, held_reason`
- `webhook_events`: `provider, event_id UNIQUE, signature_ok, payload🔒, received_at, processed_at`. Duplicates are ignored.
- `invoices`: `business_id, number (sequential per FY), lines jsonb, fee_paise, gst_paise (CGST/SGST/IGST split), tds_paise, pdf_key`
- `payslips`: `booking_id, lines jsonb, gross_paise, deductions_paise, net_paise, pdf_key`
- `reconciliation_runs`: `date, provider_total, ledger_total, diff_paise, status, report_key`

**Trust and safety**
- `strikes`: `worker_id, booking_id, kind (late_cancel|no_show), points, emergency_claimed, appeal_status, expires_at`
- `ratings`: `booking_id, rater_type, stars, tags[], comment, weight, revealed_at`. Blind until both sides rate or 72h pass.
- `disputes`: `booking_id, opened_by, kind, disputed_minutes, disputed_paise, evidence jsonb, status, sla_due_at, assignee, decision, decision_reason, second_approver`
- `chats`, `messages`: `body, flags[] (link|payment_request|phone_number|abuse), hidden_at, hidden_reason`
- `sos_events`, `incidents`: `reporter (nullable for anonymous), category, site_id, severity, status, assigned_to, actions jsonb`
- `fraud_flags`: `subject_type, subject_id, rule_code, score, evidence jsonb, status (open|confirmed|dismissed), reviewer, reason`
- `audit_log`: `actor_id, actor_role, action, target_type, target_id, before jsonb, after jsonb, reason, ip, at, prev_hash, hash`. Append-only and hash-chained, so tampering is detectable.

## 6. Main flows

### 6.1 Worker onboarding
1. Language → consent screen (purpose-by-purpose, in their language, audio available) → phone + OTP.
2. **KYC**, via DigiLocker (mock) or a licensed-provider fallback. We receive name, birth year and a photo. We store name 🔒, birth year, `age_verified_at` and the provider reference. We discard the photo after deriving the face embedding. **Under 18 → stop.**
3. **Liveness selfie.** Liveness check plus a face match against the KYC photo (threshold `[CONFIG]`). The resulting face embedding goes through a dedup search; a match above the threshold creates a fraud flag and the account stays unverified until reviewed.
4. **Payout method.** UPI or bank, verified by penny drop (mock). The name match against the KYC name must be ≥ the threshold, and below it goes to manual review. The account hash is deduped across workers.
5. **Profile:** skills, languages, travel radius, two-wheeler, availability.

Status becomes `verified` and the worker can accept shifts. Browsing is allowed from step 1.

### 6.2 Business onboarding
1. Owner signs up with phone + OTP. Business details: GSTIN (mock GSTN lookup, legal-name match), or Udyam / Shops & Establishments number; PAN; the authorised person's KYC.
2. Add sites. Each site gets a map pin, address and geofence (default 150m), plus a state and wage zone derived from the pin.
3. Ops verifier queue: approve or reject with a reason. Approval verifies the business and its sites; each later site needs light re-verification.
4. Invite members (manager/supervisor) by phone.

### 6.3 Posting and funding a shift
1. The form collects the fields from the brief. Requirements are picked from a whitelist per role (skills, languages, two-wheeler, lift-capacity disclosure). Free-text discriminatory requirements are blocked by keyword and ML flagging, and a gender requirement needs the approval flow.
2. **Minimum wage check:** `effective_hourly(base pay only, allowances excluded) ≥ min_wage(state, role_category, skill_level, zone, date) / standard_hours`. Allowances never count toward the minimum.
3. **Cost preview:**
   - `worker_pay_total = headcount × pay`
   - `+ allowances`
   - `+ fee (15%)`
   - `+ GST 18% on fee`
   - `(+ welfare/TDS line items as configured)`
   - A worked example is shown on screen.
4. **Funding:** create a payment intent with the escrow provider (mock). Webhook `payment.captured` (signature verified) → journal `fund` → shift becomes `live`. Unfunded shifts are never visible to workers.
5. **New-business limits:** first 30 days, max 20 headcount per shift and ₹50k outstanding `[CONFIG]`.

### 6.4 Finding and accepting
- **Feed:** shifts within the worker's radius (PostGIS), matching their skills and languages, sorted by start time. Each card shows full pay, ₹/hour, total, address, timing, dress code and allowances.
- **Accept** is one DB transaction:
  - `UPDATE shifts SET filled_count = filled_count+1 WHERE id=$1 AND status='live' AND filled_count < headcount RETURNING ...`
  - If no row comes back, the shift is full and the worker is offered the waitlist.
  - Insert the booking. The exclusion constraint rejects overlaps and the rest gap.
  - The rule engine checks the daily and weekly hour caps and the max concurrent future bookings (new worker: 2; established: 5) `[CONFIG]`.
  - Rate limit: 10 accepts/min per worker, plus per-IP and per-device limits.
- **Waitlist:** when a slot frees up, the next waitlisted worker gets an offer with a TTL (10 min, shrinking to 3 min within 6h of the start) `[CONFIG]`. If they don't respond, it goes to the next person.
- **Reminders:** T-24h and T-3h, with "I'm coming / I can't come" buttons. "Can't come" frees the slot to the waitlist.
- **No confirmation by T-2h:** the business is notified and standby is alerted. The booking is not auto-cancelled.

### 6.5 Check-in and check-out
1. The supervisor opens the shift in supervisor mode and a QR code is displayed. The QR payload is `HMAC(site_secret, shift_id | 30s time step)`, rotated every 30s. The server accepts the current step ±1.
2. The worker taps **Check in**. The app collects GPS (with accuracy), mock-location detection, a Play Integrity token (mock), the QR scan and a liveness selfie.
3. Server checks:
   - Inside the geofence, with accuracy ≤ 100m (otherwise flagged, not blocked).
   - The QR is valid for this shift and the current time step.
   - Face match ≥ the threshold against the profile embedding.
   - The integrity verdict.
4. Result:
   - All pass → `checked_in`.
   - Soft failures (GPS accuracy, integrity, mock location) → check-in recorded with flags → fraud review queue and a supervisor prompt to confirm visually.
   - Hard failures (wrong QR, face mismatch) → rejected, with retry and supervisor fallback.
5. **Breaks:** the worker taps start and end, and the supervisor can record them. The posted unpaid break is deducted in proportion to time worked; longer recorded breaks are capped at the posted break (DECISIONS D-049).
6. **Check-out** uses the same checks. Leaving the geofence for more than 20 minutes `[CONFIG]` without a break creates a flag, not an automatic deduction.
7. **Offline fallback:**
   - The supervisor app caches the roster and the site secret-derived key, and generates QR codes offline.
   - The worker app stores signed check-in events locally and syncs them later.
   - If both are offline, the supervisor can mark attendance manually, with a photo and timestamp. That is mode `offline_supervisor`: the worker must confirm later in their app, and it's always auditable and flagged at sync.
   - Events with `occurred_at` far from `received_at` are reconciled and flagged.

### 6.6 Timesheets, approval and payout
- The timesheet is computed from attendance events (rounding rules `[CONFIG]`, default to the minute) and capped at scheduled time unless overtime was agreed.
- The business has 12h `[CONFIG]` to approve or dispute. If it doesn't act, the timesheet auto-approves.
- **Partial dispute:** the business specifies the disputed minutes and reason. The undisputed amount is released immediately and only the disputed paise stay held.
- **Approval:** journal moves escrow → `worker_payable` + `platform_revenue` + `gst_payable` (+ TDS/welfare). A payout job is created with idempotency key `payout:<booking_id>:<seq>`.
- **Payout worker:**
  - Sends to the verified payout method via the provider (mock).
  - Retries with backoff on the same idempotency key.
  - The webhook confirms the payout.
  - Failure → `held`, the worker is notified to fix their method, and ops are alerted if the SLA (24h) is at risk.
- **Payslip:** hours, rate, base, overtime, allowances, deductions (if any are legally applicable), net, and the business name.
- **Invoice:** monthly or per-shift GST invoice for the fee.
- **Daily reconciliation:** provider settlement report vs. the ledger. Any non-zero diff opens a finance incident.

### 6.7 Cancellations and no-shows (defaults, all `[CONFIG]`)

| Event | Consequence |
|---|---|
| Business cancels > 24h before | Full refund of escrow to the business, minus any non-refundable gateway cost (shown upfront) |
| Business cancels 6–24h before | Each booked worker gets 25% of shift pay from escrow |
| Business cancels < 6h before | 50% of shift pay |
| Turned away at gate / site not ready (worker checked in) | max(4h pay, 50% of shift pay), capped at full pay |
| Worker cancels > 12h before | No penalty |
| Worker cancels < 12h | 1 strike point |
| No-show | 2 points |
| ≥ 3 points in 30 days | 7 days limited (max 1 future booking) |
| ≥ 6 points | 30-day suspension pending human review. Never automatic permanent bans. Closing the account after review needs 14 days' written notice (D-091). |
| Emergency exception | 2 per 90 days, removes the strike, no proof needed. More claims → appeal with optional proof. |
| Strike expiry | 90 days. Every strike can be appealed, and an ops decision comes within 72h. |
| Overtime | Business requests → worker accepts in the app → business tops up escrow → paid at 2× the ordinary rate `[CONFIG][LEGAL]` |

### 6.8 Ratings and disputes
- **Ratings** are blind until both sides rate or 72h pass.
- A worker's displayed score is a Bayesian average with prior weight 5 and a 1.5× weight cap. Ratings > 2σ below a business's own average are down-weighted, and the first rating counts at reduced weight.
- A business whose ≤ 2★ rate exceeds 30% `[CONFIG]` over ≥ 10 ratings goes into review.
- **Disputes** auto-collect evidence (attendance events, selfies, geofence traces, chat). SLA: acknowledged within 24h, resolved within 5 days `[CONFIG]`. The decision and reason are shown to both sides. Above ₹2,000 `[CONFIG]`, a second approver is required.

### 6.9 Chat and masking
- Chat opens per booking from acceptance until 48h after the shift.
- Messages are scanned for URLs, UPI IDs and payment-request patterns ("deposit", "fees", "advance", "registration", in all three languages), phone numbers and abuse.
- Payment-request patterns are blocked and the recipient sees a warning card; phone numbers are masked.
- Users can report any message.
- Masked calling uses a mock adapter (Exotel-style virtual numbers).

### 6.10 Safety
- **SOS** is a big button during an active shift. It alerts the ops safety queue (P1), sends a location trail, and optionally shares a live-location link with a trusted contact (expires after 4h).
- **Incident reports** are reachable from every screen menu. Anonymous mode is allowed; they go to a human queue.
- **Night shifts:** a state-level rule set covers night hours, women's consent, transport and the number of women per shift `[CONFIG][LEGAL]`. Posting validates against it, and the business must attest to transport.
- **Site pause:** ops safety can pause a site instantly. Future bookings are notified, and affected workers get compensation per policy.

### 6.11 Admin console
- **Queues:** business verification, worker flags, shift flags, disputes, payouts (held/failed), SOS/incidents, appeals, gender-requirement approvals.
- **Dashboards:** fill rate, no-show rate, time to fill, payout delay (p50/p95), dispute rate, fraud flags by rule.
- **No direct editing** of timesheets or amounts. Corrections are compensating journal entries with a reason and maker-checker.

### 6.12 Privacy (DPDP)
- Consent is captured per purpose and version, and can be withdrawn.
- Data inventory and retention table (defaults, all `[LEGAL]`):

| Data | Why | Retention |
|---|---|---|
| Phone | Login, contact | Account life + 180 days |
| Legal name, birth year, KYC ref | Identity, age | Account life + 3 yrs (legal hold for disputes) |
| Face embedding | Anti-proxy | Account life; deleted on deletion request |
| Check-in selfies | Attendance proof | 90 days (longer if under dispute) |
| Location at check-in/out | Attendance | 1 year |
| Payout details | Paying the worker | Account life + 8 yrs for financial records |
| Ledger, invoices, payslips | Tax/accounting | 8 years |
| Chat | Disputes, safety | 1 year |

- **Self-service export** produces JSON (PDF pending L-42). Consents (except account) can be withdrawn in the app; retention runs daily (D-082 to D-085).
- **Deletion:** the account is deleted except for records under legal retention, plus fraud-prevention hashes (phone hash, account hash, face-embedding hash) kept under legitimate use `[LEGAL]`.
- **Logs** use a PII-masking logger. Analytics events carry only pseudonymous IDs.
- A **grievance officer** contact is shown in the app (placeholder), and a **breach plan** lives in `docs/BREACH_RESPONSE.md` (Phase 6).

## 7. Non-functional
- **Rate limits:** OTP 3/15 min per phone and 10/hr per IP; login; accept; chat.
- **Security:** OWASP Top 10 test suite, CSP, secure cookies, CSRF on web, and strict JSON schema on every input.
- **Performance:** the accept path handles 200 concurrent accepts for the last slot with exactly one success. Phase 6 load test: 1000–3000 simultaneous accepts, exact headcount, about 1000 req/s per process (`docs/LOAD_TEST.md`).
- **Performance on worker devices:** API payloads < 50KB for the feed, and images compressed client-side.

## 8. Testing strategy
- **Unit (Vitest):** money maths, fee/GST/TDS, min-wage validation, rule engine, ratings weighting, QR tokens.
- **Integration (Vitest + real local Postgres + mock providers):** booking concurrency, payments, payouts, webhooks, KYC, reconciliation.
- **E2E (Playwright):** business web, admin, and the worker app via Expo web build.
- **Abuse tests:** one or more per `ABUSE_CASES.md` ID, in `apps/api/test/abuse/<ID>.test.ts`.
- **Run everything:** `npm test`.

## 9. Build phases

| Phase | Delivers | Done when |
|---|---|---|
| **1 Foundation** ✅ | Monorepo, docker-compose, schema + migrations + seed, OTP auth (mock SMS), sessions, RBAC middleware, audit log, admin login + skeleton, README | `npm run setup && npm run dev` runs everything; RBAC + audit + OTP rate-limit tests pass |
| **2 Supply & demand** ✅ | Business onboarding + verification queue, sites/geofence, rate table, shift posting with min-wage + cost preview, funding (mock escrow + webhooks), worker onboarding (mock KYC, liveness, penny drop), feed, accept with booking rules, waitlist | Concurrency test (200 → 1) passes; you can post → fund → accept in the browser |
| **3 The shift** ✅ | Rotating QR, check-in/out with geofence + selfie + integrity (mock), breaks, offline fallback, timesheets, approval/auto-approval/partial dispute, payouts (mock), payslips, invoices, ledger + reconciliation | Full journey E2E; double-payout and webhook replay tests pass |
| **4 Trust layer** ✅ | Cancellations + compensation, strikes + appeals, ratings, disputes, chat + filters, masking, SOS, incidents, site pause, fraud rules, admin queues | Every abuse test passes |
| **5 Real users** ✅ | Hindi + Kannada, voice prompts, low-bandwidth/offline polish, notifications (SMS/WhatsApp mock → sandbox), dashboards | Worker app usable in Hindi end to end on a throttled network |
| **6 Go-live readiness** 🟡 | Security review + fixes, data rights (export, deletion, consent withdrawal, retention), load test (Node script, D-086), breach plan, go-live checklist, legal review pack, sandbox→live switch procedure | Built and tested; waiting on owner + lawyer sign-off. Live switch only with explicit permission |
