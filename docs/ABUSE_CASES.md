# ShiftKart — Abuse Cases (v0.1, draft for review)

Each case lists **How** it would happen, how we **Prevent** it, how we **Detect** it, the **Test** that covers it (file: `apps/api/test/abuse/<ID>.test.ts` unless noted), and the build **Phase** it's implemented in.

Actors: 🏢 business · 👷 worker · 🧑‍💼 our staff · 🌐 outsider · ⚙️ system.

## Test status

| Case | Status | Test file (`apps/api/test/…` unless noted) |
|---|---|---|
| ACC-02 OTP abuse | ✅ Phase 1 | `abuse/ACC-02.test.ts` |
| ACC-03 Token replay | ✅ Phase 1 | `abuse/ACC-03.test.ts` |
| ACC-04 Ex-member access | ✅ Phase 1 | `abuse/ACC-04.test.ts` |
| ACC-01 SIM swap / stolen phone | ◐ Phase 2 part: changing the payout account needs a fresh live selfie and starts a 24 h cooldown. Limited new-device sessions in Phase 3. | `abuse/WRK-01.test.ts` (MON-04 block) |
| BIZ-01 Fake jobs to harvest IDs | ✅ Phase 2 part: unverified businesses can't post; posts asking for documents go to review; businesses never see KYC data. Chat warnings in Phase 4. | `abuse/BIZ.test.ts`, `integration/phase2-journey.test.ts` |
| BIZ-03 Illegal / dangerous jobs | ✅ Phase 2 (fixed role list, keyword review, high-hazard review, own verified sites only) | `abuse/BIZ.test.ts` |
| BIZ-04 Someone else's GSTIN | ✅ Phase 2 | `abuse/BIZ.test.ts` |
| BIZ-07 Discrimination | ✅ Phase 2 (no free-text requirements, keyword review, gender requirements need compliance) | `abuse/BIZ.test.ts` |
| PAY-04 Allowances to dodge minimum wage | ✅ Phase 2 | `unit/shift-cost.test.ts`, `abuse/BIZ.test.ts` |
| PAY-05 Wrong wage category | ✅ Phase 2 | `unit/shift-cost.test.ts`, `abuse/BIZ.test.ts` |
| PAY-10 Funding never arrives | ✅ Phase 2 | `abuse/SYS-04.test.ts` |
| WRK-01 Multiple accounts | ✅ Phase 2 (identity, face, bank/UPI, device) | `abuse/WRK-01.test.ts` |
| WRK-02 Proxy worker | ✅ Phase 2 + 3 (selfie matches ID at onboarding, and at every check-in/out with liveness) | `abuse/WRK-01.test.ts`, `abuse/ATTENDANCE.test.ts` |
| WRK-03 Buddy punching | ✅ Phase 3 | `abuse/ATTENDANCE.test.ts` |
| WRK-04 GPS spoofing | ✅ Phase 3 (flagged, shown to supervisor, sent to review; not silently blocked) | `abuse/ATTENDANCE.test.ts` |
| WRK-05 Screenshotted QR | ✅ Phase 3 (30 s codes, ±1 step, bound to shift; geofence + selfie still required) | `unit/phase3.test.ts`, `abuse/ATTENDANCE.test.ts` |
| WRK-12 Check in and leave | ✅ Phase 3 (location pings with consent; 20+ min away → flag; business can dispute minutes) | `abuse/ATTENDANCE.test.ts` |
| WRK-07 Re-registering | ✅ Phase 2 | `abuse/WRK-01.test.ts` |
| WRK-08 Slot hoarding | ✅ Phase 2 | `abuse/SYS-02.test.ts` |
| WRK-09 Bots | ◐ Phase 2 + 3: per-worker accept rate limit; device integrity verdict checked at check-in (mock). Integrity on accept with the real Play Integrity API at go-live. | `abuse/SYS-09.test.ts`, `abuse/ATTENDANCE.test.ts` |
| OFF-02 Middleman takes a cut | ✅ Phase 2 (payout must be in the worker's own name, not shared) | `abuse/WRK-01.test.ts` |
| MON-04 Payout redirected after takeover | ✅ Phase 2 + 3 (pay waits out the 24 h cooldown) | `abuse/WRK-01.test.ts`, `abuse/MONEY.test.ts` |
| MSG-01 Scraping / IDOR | ✅ Phase 1 + 2 (no worker directory; roster minimal) | `abuse/MSG-01.test.ts` |
| MSG-05 OWASP basics | ✅ Phase 1 + 2 (route × role matrix covers all new routes) | `security/owasp.test.ts`, `security/rbac-matrix.test.ts` |
| MSG-06 PII in logs | ✅ Phase 1 | `abuse/MSG-06.test.ts` |
| INT-01 Silent edits | ✅ audit log, policy, ledger, attendance and payslips append-only; timesheet amounts frozen by trigger; no edit routes | `abuse/INT-01.test.ts`, `abuse/SYS-04.test.ts`, `abuse/MONEY.test.ts`, `abuse/ATTENDANCE.test.ts` |
| INT-02 Masked personal data | ✅ Phase 1 + 2 (phones, payout details finance-only and masked) | `abuse/INT-02.test.ts`, `abuse/INT-06.test.ts` |
| INT-06 Wage-table tampering | ✅ Phase 2 (two-person approval, no backdating, amounts frozen; same for policy values) | `abuse/INT-06.test.ts` |
| SYS-01 Double-booking the last slot | ✅ Phase 2 (200 concurrent → exactly 1; 200 → exactly 30) | `abuse/SYS-01.test.ts` |
| SYS-02 Overlaps / rest gap | ✅ Phase 2 | `abuse/SYS-02.test.ts` |
| SYS-04 Webhook forgery / replay | ✅ Phase 2 | `abuse/SYS-04.test.ts` |
| SYS-06 Ledger mismatch | ✅ Phase 3 (balanced journals + daily reconciliation against the provider) | `abuse/SYS-04.test.ts`, `abuse/MONEY.test.ts`, `integration/phase3-journey.test.ts` |
| SYS-07 Midnight / timezone | ✅ Phase 2 | `abuse/SYS-02.test.ts` |
| SYS-09 Waitlist offer race | ✅ Phase 2 | `abuse/SYS-09.test.ts` |
| PAY-01 Disputing everything | ✅ Phase 3 (only disputed minutes held; rest + allowances paid at once; frequent disputers flagged; big awards need a second officer) | `abuse/MONEY.test.ts` |
| PAY-02 Ignoring timesheets | ✅ Phase 3 (auto-approve after 12 h) | `abuse/MONEY.test.ts` |
| PAY-06 Unpaid extra time | ✅ Phase 3 (paid time = scheduled window; staying late without agreed overtime flagged) | `abuse/ATTENDANCE.test.ts`, `unit/phase3.test.ts` |
| PAY-07 Unfunded overtime | ✅ Phase 3 (worker can't accept until the business has paid; paid at 2×) | `abuse/MONEY.test.ts` |
| PAY-09 Chargeback after payout | ✅ Phase 3 (workers keep pay; business suspended; loss booked) | `abuse/MONEY.test.ts` |
| PAY-12 Supervisor ghost workers | ✅ Phase 3 (hand-marked attendance unpaid until the worker confirms with a selfie; worker can reject; high manual ratio flagged) | `abuse/ATTENDANCE.test.ts` |
| INT-03 Manual payouts to self | ✅ Phase 3 (two finance officers, verified account only, daily limit) | `abuse/MONEY.test.ts` |
| SYS-03 Double payout | ✅ Phase 3 (parallel runners and crash-after-transfer both pay once) | `abuse/MONEY.test.ts` |
| SYS-05 Payout vs refund race | ✅ Phase 3 (settlement waits for final timesheets; escrow can't go negative) | `abuse/MONEY.test.ts` |
| SYS-08 Offline clock tampering | ✅ Phase 3 (time taken from the gate code; drift flagged; >24 h refused) | `abuse/ATTENDANCE.test.ts` |
| PAY-03 Repeated late cancels | ✅ Phase 4 (automatic compensation from escrow; 3 late cancels in 30 days → flag + new shifts reviewed) | `abuse/TRUST.test.ts`, `e2e/trust.spec.ts` |
| PAY-08 Revenge ratings / extortion | ✅ Phase 4 (blind ratings, weighted score, harsh raters flagged) | `unit/ratings.test.ts`, `abuse/COMMUNITY.test.ts` |
| PAY-11 Turned away unpaid | ✅ Phase 4 (turn-away pay; no route marks a checked-in worker a no-show) | `abuse/TRUST.test.ts` |
| WRK-10 Emergency abuse | ✅ Phase 4 | `abuse/TRUST.test.ts` |
| WRK-11 False disputes / fake SOS | ✅ Phase 4 (disputes judged against attendance evidence; SOS never changes pay) | `abuse/COMMUNITY.test.ts`, `abuse/MONEY.test.ts` |
| BIZ-02 Fees / deposits | ✅ Phase 2 + 4 (posts reviewed; chat blocks money requests, warns the worker, flags the business) | `abuse/BIZ.test.ts`, `abuse/COMMUNITY.test.ts`, `e2e/trust.spec.ts` |
| BIZ-05 Bait-and-switch | ✅ Phase 2 + 4 (no edits; "work didn't match" reports → flag at 3) | `abuse/COMMUNITY.test.ts` |
| BIZ-06 Stalking via shifts | ✅ Phase 2 + 4 (minimal roster; worker can block a business) | `abuse/COMMUNITY.test.ts` |
| OFF-01 Off-platform hiring | ✅ Phase 4 (masked contact; honest hire route with business-paid fee; worker never penalised) | `abuse/COMMUNITY.test.ts` |
| MON-01 Self-dealing | ✅ Phase 4 (worker on a business member's phone can't take its shifts) | `abuse/COMMUNITY.test.ts` |
| MON-02 Laundering | ✅ Phase 3 + 4 (caps, refunds to source, new-business velocity flag) | `abuse/MONEY.test.ts`, `abuse/COMMUNITY.test.ts` |
| MON-03 Money-mule recruiting in chat | ✅ Phase 4 (money requests blocked) | `unit/chat-filter.test.ts` |
| MSG-02 Spam / abuse in chat | ✅ Phase 4 (rate limit, abuse filter, report, block) | `abuse/COMMUNITY.test.ts` |
| MSG-03 Scam links / payment requests | ✅ Phase 4 | `unit/chat-filter.test.ts`, `abuse/COMMUNITY.test.ts` |
| MSG-04 Number harvesting | ✅ Phase 4 (numbers masked, masked calling) | `unit/chat-filter.test.ts`, `abuse/COMMUNITY.test.ts` |
| INT-04 Ops collusion | ✅ Phase 2 + 4 (two approvers for high risk; random re-review; verifier oversight) | `abuse/BIZ.test.ts`, `abuse/COMMUNITY.test.ts` |
| INT-05 Bulk export | ✅ Phase 1 + 4 (page caps, instant offboarding, read-volume flag) | `abuse/INT-05.test.ts`, `abuse/COMMUNITY.test.ts` |
| SAF-01 Harassment | ✅ Phase 4 (easy report, anonymous option, human queue, business can't read reports) | `abuse/COMMUNITY.test.ts` |
| SAF-02 Emergency | ✅ Phase 4 (SOS → safety desk, trusted-contact live link that expires) | `abuse/COMMUNITY.test.ts`, `e2e/trust.spec.ts` |
| SAF-03 Night shifts | ✅ Phase 4 (transport promise + worker consent) | `abuse/TRUST.test.ts` |
| SAF-04 Site pause | ✅ Phase 2 + 4 (pause cancels upcoming shifts with compensation) | `abuse/SYS-09.test.ts`, `abuse/TRUST.test.ts` |
| WRK-06 Underage | ✅ Phase 2 + 4 (ID-based age; supervisor report → review) | `abuse/WRK-01.test.ts`, `abuse/COMMUNITY.test.ts` |
| End-to-end journeys | ✅ business signup → live shift; worker Hindi signup → accept; shift day → paid; trust (scam message blocked, SOS on safety desk, late cancel compensated) | `e2e/*.spec.ts` (repo root) |
| All others | ⏳ Planned for the phase listed on each case | — |

---|---|---|
| ACC-02 OTP abuse | ✅ Phase 1 | `apps/api/test/abuse/ACC-02.test.ts` |
| ACC-03 Token replay | ✅ Phase 1 | `apps/api/test/abuse/ACC-03.test.ts` |
| ACC-04 Ex-member access | ✅ Phase 1 | `apps/api/test/abuse/ACC-04.test.ts` |
| MSG-01 Scraping / IDOR | ✅ Phase 1 part (business/user data). Worker profiles come in Phase 2. | `apps/api/test/abuse/MSG-01.test.ts` |
| MSG-05 OWASP basics | ✅ Phase 1 part | `apps/api/test/security/owasp.test.ts`, `rbac-matrix.test.ts` |
| MSG-06 PII in logs | ✅ Phase 1 | `apps/api/test/abuse/MSG-06.test.ts` |
| INT-01 Silent edits | ✅ Phase 1 part (audit log, policy). Timesheet/ledger parts come in Phase 3. | `apps/api/test/abuse/INT-01.test.ts` |
| INT-02 Masked personal data | ✅ Phase 1 part (phones). Bank details come in Phase 2/3. | `apps/api/test/abuse/INT-02.test.ts` |
| All others | ⏳ Planned for the phase listed on each case | — |

---

## A. Fake or predatory businesses

### BIZ-01 🏢 Fake jobs to harvest workers' ID documents
- **How:** A "business" posts attractive shifts, then asks workers on chat or phone for Aadhaar, PAN or bank photos "for verification".
- **Prevent:**
  - Businesses never see KYC data. We only expose "Verified ✓" and the worker's first name.
  - Unverified businesses can't post.
  - Every shift must be pre-funded, so a fake costs real money.
  - Chat blocks phone numbers, and document requests trigger a warning card ("ShiftKart already verified this person. Never send ID documents.").
- **Detect:**
  - Chat classifier flags `aadhaar|pan|photo of card|document` patterns in all three languages.
  - Funded-then-cancelled-repeatedly pattern.
  - Worker reports.
- **Test:** API never returns KYC fields to business roles (schema snapshot). A chat message with a document request is flagged and the warning is inserted. An unverified business gets 403 on create shift. · **Phase:** 2/4

### BIZ-02 🏢 Asking workers for a fee or deposit
- **How:** "Pay ₹500 registration / uniform deposit to confirm your slot."
- **Prevent:**
  - The product has no worker-pays flow at all: no endpoint, no ledger account type.
  - Chat blocks UPI IDs, payment links and fee/deposit phrases from business senders, and shows a warning.
  - The "ShiftKart never asks for money" banner appears everywhere.
  - One-tap "They asked me for money" report.
- **Detect:** Any confirmed report → business suspended pending review, and every worker who had a booking with them is notified.
- **Test:** Ledger has no journal kind that debits a worker account except reversal of our own error. A chat message with `upi://` / `@okaxis` / "deposit" from a business is blocked. A report triggers an auto-flag. · **Phase:** 3/4

### BIZ-03 🏢 Illegal or dangerous jobs
- **How:** Posts disguised work (handling hazardous material without gear, transporting goods across states, "escort" work, liquor sale without licence) under a benign role.
- **Prevent:**
  - Roles come from a fixed list with `hazard_level`, and prohibited categories don't exist.
  - The description is scanned for prohibited keywords.
  - High-hazard roles need ops approval per shift.
  - The site must be a verified address. "Travel to another city" shifts are not allowed in v1.
- **Detect:** Worker incident reports, gate-turnaway clusters, and keyword flags → shift flag queue. One serious report pauses the site (SAF-04).
- **Test:** A shift with a prohibited keyword goes to `pending_review`, not `live`. A high-hazard role requires approval. A site address ≠ the business's verified sites → rejected. · **Phase:** 2/4

### BIZ-04 🏢 Using another company's GSTIN or PAN
- **How:** Enters a real, valid GSTIN belonging to someone else.
- **Prevent:**
  - GSTN legal name must match the entered name.
  - The authorised signatory's KYC name must match a director or proprietor (fuzzy, with review below threshold).
  - The penny drop on the business's refund account must match the legal name.
  - Site visit or video verification for the higher risk tier.
- **Detect:** The same GSTIN on two accounts → flag.
- **Test:** GSTIN name mismatch → `pending_review`. Duplicate GSTIN → rejected with flag. · **Phase:** 2

### BIZ-05 🏢 Bait-and-switch shift details
- **How:** Posts "billing counter" but makes workers do heavy loading, or a longer day, or a different site.
- **Prevent:**
  - Shift details are frozen once anyone has booked. Material edits (time, site, role, pay down) cancel the shift under the cancellation rules, with compensation.
  - Workers can mark "work didn't match" at check-out.
- **Detect:** A high "didn't match" rate → business review.
- **Test:** Editing role/time/site/pay-down on a booked shift → 409. A pay-up edit is allowed. Mismatch reports aggregate into a flag. · **Phase:** 2/4

### BIZ-06 🏢 Shift used to lure or stalk a specific person
- **How:** A business posts a shift hoping a specific woman accepts, to get her name and face.
- **Prevent:**
  - Businesses can't pick or invite named workers in v1, and can't see photos before check-in day.
  - Worker home location is never shared.
  - Supervisor sees the roster with first name + photo only on the day.
  - Workers can block a business.
- **Detect:** Repeated cancel-and-repost patterns. Harassment reports.
- **Test:** The business roster endpoint hides photos until the shift day. A block prevents the blocked business's shifts from appearing. · **Phase:** 2/4

### BIZ-07 🏢 Discrimination through proxy requirements
- **How:** Requirements like "fair", "Hindu only", "from X community", "young girls", or language picks used as a caste or region proxy.
- **Prevent:**
  - Requirements are a whitelist of structured options, so there's no free-text requirement field.
  - The description is scanned for protected-attribute terms.
  - Gender requirements need a stated legal reason + compliance approval, and are logged.
  - Age requirement is only "18+" (or a higher legal minimum for specific roles).
- **Detect:** Language requirements that don't match the role (e.g. a warehouse loader requiring a specific language) → flagged.
- **Test:** A free-text requirement is rejected by the schema. A description with protected terms → `pending_review`. A gender requirement without approval → can't go live. · **Phase:** 2

---

## B. Businesses avoiding payment or rules

### PAY-01 🏢 Disputing every timesheet
- **How:** The business disputes all hours to delay or cut pay.
- **Prevent:**
  - Only the disputed portion is held. Undisputed pay goes out on time.
  - Disputes must cite minutes plus a reason category and can't exceed what attendance evidence allows.
  - Disputes against clean attendance (geofence + QR + face OK) need evidence.
- **Detect:** Dispute rate above threshold per business → review. Repeat losses → dispute privileges limited (escalating to suspension). Ops decisions are tracked.
- **Test:** Partial dispute releases the undisputed paise immediately (ledger check). A dispute rate > threshold creates a flag. · **Phase:** 3/4

### PAY-02 🏢 Ignoring timesheets
- **How:** Never approves.
- **Prevent:** Auto-approval at the deadline, run by a scheduled job.
- **Test:** Time-travel test: no action for 12h → `auto_approved` and the payout is queued. · **Phase:** 3

### PAY-03 🏢 Repeated last-minute cancellations
- **How:** Books extra workers as insurance, then cancels late.
- **Prevent:** Late-cancel compensation is paid automatically from escrow.
- **Detect:** A late-cancel rate above threshold → the funding requirement rises (e.g. a 10% non-refundable deposit) and posting needs review.
- **Test:** A cancel at T-5h pays 50% to each booked worker. A third late cancel in 30 days creates a flag. · **Phase:** 4

### PAY-04 🏢 Below minimum wage via "allowances"
- **How:** Base ₹200/day + "meal allowance" ₹300 to look compliant.
- **Prevent:**
  - The minimum-wage check uses base pay only. Allowances are displayed separately and never counted.
  - Per-shift pay is converted to hourly over the shift length.
- **Test:** A shift whose base is below minimum but base + allowances is above → rejected. Boundary tests at exactly minimum. · **Phase:** 2

### PAY-05 🏢 Wrong role category to get a lower minimum wage
- **How:** Posts "helper" (unskilled) for work needing a skilled worker, such as a billing operator.
- **Prevent:**
  - Each role code maps to one wage category, and business can't choose the category.
  - Requirements like "billing software" force at least the semi-skilled category.
- **Detect:** Worker "didn't match" reports (BIZ-05).
- **Test:** A role requiring the skill `billing_software` resolves to the semi-skilled rate. · **Phase:** 2

### PAY-06 🏢 Unpaid time: "training", early arrival, holding after checkout
- **How:** Asks workers to come 1h early unpaid or stay after.
- **Prevent:**
  - Paid time runs from scheduled start or check-in (whichever is later, if within a grace window) to check-out.
  - Asking for extra time requires an overtime request in the app.
  - The posting form has no "unpaid training" field.
- **Detect:** Check-out much later than end with no overtime request → flag + worker prompt "Were you asked to stay?"
- **Test:** A late check-out with no overtime request creates a flag. Overtime is only paid if requested and accepted, and the business must top up. · **Phase:** 3/4

### PAY-07 🏢 Unfunded overtime or underfunded escrow
- **How:** Agrees to overtime but has no money.
- **Prevent:** The overtime request requires an escrow top-up before the worker sees "Accept". If unfunded, ops follow up and the business account is limited until paid.
- **Test:** Overtime without top-up can't be accepted. · **Phase:** 3

### PAY-08 🏢 Revenge ratings / rating extortion
- **How:** "Give us 5 stars or we dispute your hours." Or one bad rating to punish a worker.
- **Prevent:**
  - Ratings are blind until both sides rate, and independent of approval.
  - Approving or disputing timesheets has no link to the worker's rating.
  - Outlier weighting and a weight cap mean one rating can't sink a worker.
- **Detect:** A business with > 30% extreme low ratings → review.
- **Test:** A single 1★ among ten 5★ moves the score < 0.3. A business with many 1★ gets flagged. Ratings stay hidden until both sides submit. · **Phase:** 4

### PAY-09 🏢 Chargeback after workers are paid
- **How:** The business funds with a card or UPI, workers are paid, then the business raises a chargeback.
- **Prevent:**
  - Prefer funding methods with low reversal risk (UPI, netbanking, NEFT). Cards are allowed only for verified, established businesses.
  - New businesses' payouts still go out (workers are never penalised), but exposure is capped.
- **Detect:** Chargeback webhook → journal moves the loss to `chargeback_loss`, the business is suspended and recovery is pursued. **Worker payouts are never clawed back.**
- **Test:** Chargeback webhook after payout → worker ledger is untouched, the business is suspended, and the loss is booked. · **Phase:** 3

### PAY-10 🏢 Failed or bounced funding
- **How:** The payment shows pending, then fails.
- **Prevent:** A shift goes `live` only on a signature-verified `captured` webhook, never on client-side success.
- **Test:** Client "success" with no webhook → shift stays `pending_funding`. A failed webhook → stays unpublished. · **Phase:** 2

### PAY-11 🏢 Turning workers away without paying
- **How:** "Site not ready, go home", and the business claims they never came.
- **Prevent:** Checked-in workers (geofence + QR + selfie evidence) get the turn-away minimum automatically if the shift is cancelled after check-in, or if the supervisor marks "turned away".
- **Detect:** A business marks a worker no-show despite a valid check-in → blocked.
- **Test:** No-show marking on a checked-in booking → 409. A turn-away pays the minimum. · **Phase:** 4

### PAY-12 🏢 Supervisor creates ghost workers
- **How:** The supervisor uses offline mode to "check in" friends who never came.
- **Prevent:** Offline supervisor check-ins require a worker app confirmation within 48h, and can't be paid until confirmed.
- **Detect:** Offline-mode rate per supervisor above threshold → flag.
- **Test:** An offline supervisor check-in without worker confirmation is not payable. A high offline rate creates a flag. · **Phase:** 3

---

## C. Taking people off the platform

### OFF-01 🏢👷 Business recruits workers off-platform
- **How:** "Come directly next week, I'll pay cash."
- **Prevent (mostly by value):**
  - Guaranteed pay, payslips (proof of income), ratings history, and safety/SOS for workers.
  - Pre-vetted, no-show protection, and invoices for businesses.
  - Phone numbers are masked in chat.
  - Optional conversion fee (one-time, business-paid) for full-time hires, declared via an in-app "Hire full-time" flow.
- **Detect:** Booking-pair patterns that suddenly stop. Phone-number attempts in chat.
- **No penalty to workers.** Workers are never struck or banned for leaving with a business.
- **Test:** Phone numbers in chat are masked. The conversion-fee flow charges the business only. No worker-side penalty path exists. · **Phase:** 4

### OFF-02 🏢 Business poaches through contractor middleman
- **How:** A contractor signs up as a "worker", brings people and takes a cut from their pay.
- **Prevent:** One person per account (WRK-01/02). Pay always goes to the verified worker's own account (name match). No group bookings.
- **Detect:** Many workers whose payouts are later forwarded (we can't see this). Instead we look for many workers referred by, or chatting with, the same person, or sharing a device.
- **Test:** A payout method name mismatch → can't receive. Device sharing → flag (WRK-01). · **Phase:** 2

---

## D. Fake or duplicate workers

### WRK-01 👷 Multiple accounts (same device, bank or face)
- **How:** Creates a second account to escape strikes or grab more slots.
- **Prevent:**
  - Phone OTP + KYC: one KYC identity maps to one account (provider ref hash unique).
  - Face embedding dedup (cosine similarity > threshold → block pending review).
  - Bank/UPI account hash unique across workers.
  - Device hash: more than 2 worker accounts on one device → flag.
- **Test:** Second account with the same KYC ref → rejected. Same face embedding (mock returns identical vector) → flagged. Same account hash → rejected. 3 accounts on a device → flag. · **Phase:** 2

### WRK-02 👷 Account renting or proxy workers
- **How:** A verified worker lets someone else work the shift.
- **Prevent:**
  - The selfie at every check-in and check-out is face-matched to the KYC-derived embedding, with liveness.
  - The supervisor sees the profile photo on the roster for a visual match.
- **Detect:** Face mismatch → check-in rejected, account flagged. Repeated mismatches → suspension pending review.
- **Test:** A mock face match below threshold rejects check-in and creates a flag. · **Phase:** 3

### WRK-03 👷 Buddy punching
- **How:** Friend A checks in using friend B's phone.
- **Prevent:** The selfie must match the account holder, and liveness defeats a photo held up to the camera. The QR + geofence make remote check-in hard.
- **Test:** Covered by WRK-02 + a liveness-fail case. · **Phase:** 3

### WRK-04 👷 GPS spoofing
- **How:** A mock-location app fakes being at the site.
- **Prevent:**
  - Android mock-location flag + Play Integrity verdict.
  - The rotating QR must be scanned physically, and its time step means it can't be forwarded slowly.
  - IP/cell location sanity check where available.
- **Detect:** Flagged (not silently blocked) → review queue + supervisor confirm prompt.
- **Test:** Check-in with `mock_location=true` → recorded with flag, enters queue. Integrity `FAILS_DEVICE` → flag. · **Phase:** 3

### WRK-05 👷 Screenshotted or forwarded QR
- **How:** A friend on site sends a photo of the QR to a worker at home.
- **Prevent:**
  - The QR rotates every 30s and is accepted only for current ±1 step (≤ 90s).
  - It's bound to the shift, and must be used together with an in-geofence location + live selfie.
  - Each token can be used once per worker per event type.
- **Test:** A token from 2 steps ago → rejected. A token for another shift → rejected. A valid token + out-of-geofence → flagged. · **Phase:** 3

### WRK-06 👷 Underage users
- **How:** A 16-year-old signs up with a parent's phone, or tries to pass KYC with an adult's documents.
- **Prevent:**
  - Age from the KYC source (DigiLocker or provider), never self-declared.
  - The liveness selfie must match the KYC photo, so using an adult's KYC fails the face match.
  - Check-in face match on every shift.
- **Detect:** Supervisor "looks underage" report → immediate hold + review.
- **Test:** KYC mock with birth year → age 17 → onboarding blocked. Underage report → account limited. · **Phase:** 2

### WRK-07 👷 Re-registering after suspension
- **How:** A new phone number, the same person.
- **Prevent:** The face embedding + KYC ref + account hashes are retained for fraud prevention even after deletion `[LEGAL]`.
- **Test:** A new phone + same KYC ref → blocked with "contact support". · **Phase:** 2

### WRK-08 👷 Slot hoarding
- **How:** Accepts many shifts "just in case", then drops them.
- **Prevent:** Max concurrent future bookings (2 for new, 5 for established) and the late-cancel strike.
- **Detect:** A high cancel rate even when cancelling early → reduced booking cap.
- **Test:** The 3rd booking for a new worker → rejected. · **Phase:** 2

### WRK-09 👷🌐 Bots auto-accepting shifts
- **How:** A script hammers the accept endpoint to grab every high-pay shift.
- **Prevent:**
  - Rate limits per worker, device and IP.
  - Requests need a valid session bound to device + integrity token for accept.
  - Small server-side jitter isn't needed: fairness comes from the atomic accept plus the per-worker cap.
- **Detect:** Accept latency < human threshold repeatedly → flag.
- **Test:** 11 accepts/min → 429. Accept without integrity token (when required) → 403. · **Phase:** 2

### WRK-10 👷 Abusing the emergency exception
- **How:** Claims an emergency every time.
- **Prevent:** Limit 2 per 90 days; after that, appeal with optional proof and a human decision.
- **Test:** The 3rd claim in 90 days → not auto-granted, appeal created. · **Phase:** 4

### WRK-11 👷 False disputes or fake SOS
- **How:** Claims more hours than worked, or triggers SOS to get out of a shift with pay.
- **Prevent:**
  - Disputes are evaluated against attendance logs.
  - SOS never changes pay automatically: pay is for time worked up to the SOS, and ops review it.
  - Misuse is handled case by case, never with an automatic penalty, because a real emergency must never be discouraged.
- **Test:** An SOS doesn't modify the timesheet. A dispute claiming minutes beyond check-out needs evidence. · **Phase:** 4

### WRK-12 👷 Check in and leave
- **How:** Checks in, goes home, comes back to check out.
- **Prevent:** Check-out requires geofence + QR + selfie. Optional mid-shift presence pings (background location only with consent; otherwise supervisor spot-check).
- **Detect:** A location trail leaving the geofence > 20 min outside a break → flag (not an automatic deduction); the business can dispute those minutes.
- **Test:** An out-of-geofence ping sequence creates a flag. · **Phase:** 3

---

## E. Collusion and money abuse

### MON-01 🏢👷 Fake shifts to farm incentives or referrals
- **How:** A business and a worker (or one person controlling both) create shifts to collect referral or promo money.
- **Prevent:**
  - No referral or incentive money in v1.
  - When added: incentives paid only after N shifts at ≥ M distinct verified businesses, with a cooling period.
  - The fee makes self-dealing cost money.
- **Detect:** Graph rules (same device/IP/bank or face across a business member and a worker; a worker who only ever works for one business with near-instant fills).
- **Test:** A business member's device = a worker's device → flag. A worker can't book their own business's shifts (same user/KYC). · **Phase:** 4

### MON-02 🏢👷 Money laundering through fake shifts
- **How:** Dirty money funds shifts; payouts go to mule accounts.
- **Prevent:**
  - KYC on both sides and name-matched payouts.
  - Per-worker daily and monthly payout caps `[CONFIG]`.
  - Refunds go only to the original funding source.
  - Escrow funds can't be withdrawn by the business except as a refund to source.
- **Detect:** Velocity rules (shift funded and completed fast, round amounts, many new workers paid by one new business, high pay rate vs market) → finance review. STR reporting process `[LEGAL]`.
- **Test:** A refund is sent to the original source only. A payout over the cap → held. The velocity rule fires on a seeded pattern. · **Phase:** 3/4

### MON-03 👷 Recruiting workers as money mules
- **How:** Someone uses chat to ask workers to "receive and forward" money.
- **Prevent:** Chat payment-request filter (MSG-03). Worker education banner.
- **Test:** Covered by MSG-03. · **Phase:** 4

### MON-04 ⚙️🌐 Payout to the wrong account after a bank-detail change
- **How:** An attacker who took over the account changes the UPI ID, then waits for payout.
- **Prevent:**
  - Changing the payout method requires OTP + a liveness selfie + a new penny drop with name match.
  - A 24h cooldown during which payouts go to the old method or are held.
  - Notification to the old contact.
- **Test:** A method change without a liveness selfie → rejected. A payout during cooldown → held. · **Phase:** 3

---

## F. Account security

### ACC-01 🌐 SIM swap or stolen phone takeover
- **How:** The attacker gets the victim's number and logs in with OTP.
- **Prevent:**
  - A new-device login → limited session (browse only) until a liveness selfie matches.
  - Payout changes need liveness (MON-04).
  - Other sessions are notified and can be revoked.
  - A "lost phone" support flow freezes payouts.
- **Test:** A login from a new device can't change payout or accept shifts until the selfie passes. · **Phase:** 2/3

### ACC-02 🌐 OTP brute force / OTP bombing / SMS pumping
- **How:** Guess codes, spam OTPs at a victim, or trigger SMS to premium numbers for toll fraud.
- **Prevent:**
  - 6-digit OTP, 5 min expiry, 5 attempts, then lock.
  - 3 sends/15 min per phone, 10/hr per IP, and a global send budget.
  - Indian (+91) numbers only. Exponential backoff.
- **Test:** 6th wrong attempt → locked. 4th send in 15 min → 429. A non-+91 number → rejected. · **Phase:** 1

### ACC-03 🌐 Session theft or token replay
- **How:** Stolen refresh token.
- **Prevent:** Short access tokens (15 min). Rotating refresh tokens with reuse detection (reuse revokes the family). Device binding.
- **Test:** Reusing an old refresh token revokes all sessions in its family. · **Phase:** 1

### ACC-04 🏢 Ex-supervisor still has access
- **How:** A supervisor leaves the company but keeps their login.
- **Prevent:** Removing a member revokes their sessions immediately. Membership is checked on every request, not cached in the token.
- **Test:** After removal, the next request → 403. · **Phase:** 1/2

---

## G. Messaging and data

### MSG-01 🌐 Scraping worker data
- **How:** A fake business or bot enumerates worker profiles.
- **Prevent:**
  - No worker search or directory for businesses at all. Businesses only see workers who booked their shifts, with minimum fields.
  - UUIDs, not sequential IDs. Rate limits and pagination caps.
- **Test:** A business requesting a worker who never booked with them → 404. IDOR tests across all `/:id` routes. · **Phase:** 1/2

### MSG-02 🏢👷 Spam or abusive chat
- **How:** Abuse, harassment, spam.
- **Prevent:** Chat only exists between booked parties during a window. Message rate limits. Abuse filter (Hindi/English/Kannada word lists + reporting). Block. Hidden messages are kept for review.
- **Test:** The 21st message in 1 min → 429. Chat with a non-booked party → 403. Reported message → in the queue. · **Phase:** 4

### MSG-03 🏢👷🌐 Scam links or payment requests in chat
- **How:** Phishing links, UPI collect requests, "pay to confirm".
- **Prevent:** Links blocked except on an allowlist (maps). UPI IDs and payment phrases blocked. Recipients see a warning.
- **Test:** URL / UPI / "send ₹" messages are blocked. · **Phase:** 4

### MSG-04 🌐 Phone-number harvesting through chat or calls
- **How:** Collects numbers to recruit or harass off-platform.
- **Prevent:** Masked numbers, masked calling, and digit sequences that look like phone numbers are redacted.
- **Test:** "nine eight seven..." and "98 76 54 32 10" patterns are redacted. · **Phase:** 4

### MSG-05 🌐 Common web attacks (OWASP Top 10)
- **How:** Injection, broken access control, SSRF and the like.
- **Prevent:** Parameterised queries (Drizzle), Zod on every input, RBAC + ownership middleware, no server-side URL fetching from user input, CSP, dependency audit.
- **Test:** `apps/api/test/security/owasp.test.ts`: SQLi payloads, IDOR matrix (every route × every role), mass assignment (extra fields rejected), XSS in chat/description escaped. · **Phase:** 1 onwards

### MSG-06 ⚙️ PII leaking into logs or analytics
- **How:** Phone or bank details printed in error logs.
- **Prevent:** A logger redaction list. Analytics events built from a schema whitelist.
- **Test:** A log of a request containing a phone/VPA is redacted (snapshot). Analytics schema rejects PII fields. · **Phase:** 1

---

## H. Our own staff (insider)

### INT-01 🧑‍💼 Admin edits timesheets or pay silently
- **How:** An admin bumps a friend's hours.
- **Prevent:**
  - No update endpoint for timesheets or amounts.
  - Corrections are compensating journals with maker-checker (two different staff).
  - Audit log is append-only and hash-chained.
- **Test:** No update route exists for these tables (route inventory test). A DB trigger blocks UPDATE on `ledger_entries`/`attendance_events`. A maker can't be their own checker. Breaking the hash chain is detected. · **Phase:** 1/3

### INT-02 🧑‍💼 Support staff viewing bank or KYC details
- **How:** Support looks up a person's bank account out of curiosity or to sell data.
- **Prevent:** Field-level RBAC (support sees masked data). Unmasking needs a reason and is logged and rate-limited. Bank details are visible only to finance, masked except the last 4 digits.
- **Test:** `ops_support` GET a worker → bank fields absent. An unmask call writes an audit entry. · **Phase:** 1/2

### INT-03 🧑‍💼 Finance creates manual payouts to themselves
- **How:** Manual payout to a staff-controlled account.
- **Prevent:** Manual payouts go only to a worker's verified method, need maker-checker, and have a daily cap. Staff can't hold worker accounts linked to their identity (KYC cross-check).
- **Test:** A manual payout by a single person → pending. Checker = maker → 403. · **Phase:** 3

### INT-04 🧑‍💼 Ops colluding with a business (approving fakes, reversing strikes)
- **How:** A verifier approves a fake business for a bribe.
- **Prevent:** High-risk-tier approvals need two approvers. Random re-review sampling (5%). Per-reviewer stats.
- **Detect:** Reviewer approval rate outliers. Businesses later confirmed fraudulent are traced back to their approver.
- **Test:** A high-risk approval by one person → stays pending. · **Phase:** 2/4

### INT-05 🧑‍💼 Disgruntled employee bulk-exports data
- **How:** Downloads every worker before leaving.
- **Prevent:** No bulk export in the admin UI. List endpoints are paginated and capped. Unusual read volume alerts. Staff offboarding revokes sessions.
- **Test:** List page size > 100 → clamped. 500 profile reads/hour → alert flag. · **Phase:** 4

### INT-06 🧑‍💼 Admin edits the minimum-wage table to allow low pay
- **How:** Lowers a rate.
- **Prevent:** Rate changes are versioned with a source reference, need compliance maker-checker, and are audit-logged. They can't take effect retroactively.
- **Test:** A rate change without a second approver doesn't apply. A backdated effective date → rejected. · **Phase:** 2

---

## I. Races and system failures

### SYS-01 ⚙️ Double-booking the last slot
- **How:** 200 workers tap accept simultaneously.
- **Prevent:** Atomic conditional `UPDATE ... WHERE filled_count < headcount` + a DB check constraint + a unique (shift, worker).
- **Test:** 200 concurrent accepts on headcount 1 → exactly 1 confirmed, 199 waitlist/full, and `filled_count = 1`. Also tested on headcount 30 with 200 → exactly 30. · **Phase:** 2

### SYS-02 ⚙️ Overlapping bookings across shifts
- **How:** Two parallel requests for two overlapping shifts.
- **Prevent:** A Postgres EXCLUDE constraint on worker + time range (with rest buffer).
- **Test:** Parallel accepts of overlapping shifts → one fails. Rest gap < config → rejected. · **Phase:** 2

### SYS-03 ⚙️ Double payout
- **How:** A retry or crash after the provider call; a duplicate job.
- **Prevent:**
  - A unique idempotency key per payout, sent to the provider.
  - Unique `provider_ref`.
  - Payout state machine transitions done with row locks.
- **Test:** Run the payout job twice concurrently → one provider call (mock counts). Simulated crash after the provider call → retry reuses the key and no second transfer happens. · **Phase:** 3

### SYS-04 ⚙️🌐 Webhook replay or forgery
- **How:** Replayed `payment.captured`; a forged webhook marks a shift funded.
- **Prevent:** HMAC signature verification, a timestamp tolerance, a unique `event_id`, and amount/reference cross-checked against our intent.
- **Test:** Bad signature → 401. Duplicate event → no-op. Amount mismatch → rejected + alert. · **Phase:** 2

### SYS-05 ⚙️ Payout after a refund (or refund after a payout)
- **How:** A business cancels and is refunded while a payout is in flight.
- **Prevent:**
  - All escrow movements lock the business escrow account row.
  - The refund amount = escrow balance minus committed (approved + pending payouts + compensation).
  - The ledger can't go negative (check at journal time).
- **Test:** Concurrent refund + payout → total out ≤ total in, and the escrow balance is ≥ 0. · **Phase:** 3

### SYS-06 ⚙️ Ledger mismatch
- **How:** Bugs, missed webhooks or manual provider actions.
- **Prevent / Detect:** Every journal balances (DB constraint via trigger). Daily reconciliation against the provider report. Any diff → finance incident.
- **Test:** An unbalanced journal insert → rejected. A seeded provider-report mismatch → reconciliation fails with a diff. · **Phase:** 3

### SYS-07 ⚙️ Timezone or midnight-crossing errors
- **How:** A night shift 22:00–06:00 IST is computed wrong.
- **Prevent:** UTC storage, IST rendering, and duration computed from timestamps.
- **Test:** A cross-midnight shift gives the correct hours; the day/week cap is attributed correctly. · **Phase:** 2

### SYS-08 ⚙️ Offline check-in tampering
- **How:** The device clock is changed to fake an earlier check-in while offline.
- **Prevent:** Offline events are signed with a device key and carry a monotonic counter + the QR time step (which proves when they were on site). Server time is used when the device time drifts > 5 min from the QR step.
- **Test:** An offline event with a device time inconsistent with the QR step → flagged, and server-derived time is used. · **Phase:** 3

### SYS-09 ⚙️ Waitlist offer race
- **How:** Two waitlisted workers both accept an offer, or an expired offer is accepted.
- **Prevent:** The offer is bound to one worker and checked against its expiry inside the accept transaction.
- **Test:** Accepting an expired offer → rejected. The offer passes to the next person. · **Phase:** 2

---

## J. Safety

### SAF-01 👷 Harassment at a site
- **How:** A worker is harassed during a shift.
- **Prevent / Respond:** An easy-to-find report (anonymous allowed) goes to a human safety queue with an SLA. The business is notified only in a way that doesn't reveal an anonymous reporter.
- **Test:** An anonymous report stores no reporter ID and is visible in the queue. The business-side view has no reporter field. · **Phase:** 4

### SAF-02 👷 Emergency during a shift
- **How:** A worker faces an emergency mid-shift.
- **Prevent / Respond:** SOS → P1 alert, location trail, trusted-contact link (expires after 4h).
- **Test:** SOS creates a P1 event. The share link expires. · **Phase:** 4

### SAF-03 🏢 Night-shift rules ignored
- **How:** A shift for women ends at 1am without transport.
- **Prevent:** The state rule engine checks night hours; the business must attest to transport, and the worker gives explicit consent at accept.
- **Test:** A night shift without transport attestation → can't go live (when the rule is configured for the state). · **Phase:** 4

### SAF-04 🏢 Serious safety report at a site
- **How:** A serious incident is reported at a site.
- **Prevent / Respond:** Ops can pause the site instantly. Live shifts are hidden, booked workers are notified and compensated per policy, and the business can't un-pause.
- **Test:** A paused site rejects new shifts and hides existing ones. · **Phase:** 4

---

## K. Gaps to revisit
- Detecting coerced workers (bonded labour, trafficking indicators): needs ops training and an NGO partnership, not just code. `[LEGAL]`
- Deepfake liveness attacks: depends on vendor capability. Revisit at vendor selection.
- Collusion between a supervisor and a worker for overtime: currently relies on the business approving the overtime top-up itself.
