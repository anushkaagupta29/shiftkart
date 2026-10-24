# Go-live checklist

> **Nothing here has been done.**
> - No accounts were created, nothing was deployed, and every provider is still a mock.
> - Each step that touches a real system needs **your explicit go-ahead at the time**, as the brief requires.
> - Vendor plans and prices change, so check each vendor's current terms before signing up.

## 0. Prerequisites only you can do
| # | Item | Why it blocks |
|---|---|---|
| G-01 | **Register a company** (e.g. a private limited company) and get its PAN/GSTIN | Needed by payment aggregators, DLT sender registration, the WhatsApp Business API, DigiLocker requester onboarding, and the Play Store organisation account. (L-32) |
| G-02 | **Engage a lawyer** for the legal review pack (LEGAL_REVIEW.md) | Terms, privacy notice, the worker/business agreements, and the employer-of-record question decide how money flows. |
| G-03 | **Appoint a grievance officer** and set `GRIEVANCE_OFFICER_NAME` / `GRIEVANCE_OFFICER_EMAIL` | The API refuses to start in production without them (DPDP, L-22). |
| G-04 | **Native-speaker review** of the Hindi and Kannada strings (`apps/worker/src/i18n.ts`, `apps/api/src/notify/templates.ts`) | I drafted them (D-077). |
| G-06 | **TDS and welfare-fee deductions** are not built (payslip deductions are 0). They need the lawyer's answers first (L-02, L-03, L-13). | Paying workers without required deductions is a compliance gap. |
| G-05 | Trademark search for "ShiftKart" | L-30 |

## 1. Vendors: sandbox first
Swap order: each adapter already has an interface and a mock (`apps/api/src/adapters/*`). Every switch follows section 4.

| Need | Candidates (sandbox/test mode) | What we'd use it for | Notes |
|---|---|---|---|
| Payments in (escrow) | Razorpay or Cashfree: free **test mode** keys | Funding shifts (replaces MockPay) | Escrow/nodal set-up for holding business money needs the PA's sign-off (L-15). |
| Payouts | RazorpayX or Cashfree Payouts: **test mode** | Worker UPI/bank payouts (replaces MockPayouts) | Idempotency keys map directly. |
| Bank account check | The same vendor's penny-drop / account-validation API | Replaces the mock penny drop | |
| KYC / age | DigiLocker via a licensed KYC provider (e.g. IDfy, HyperVerge, Signzy): **sandbox via their sales team** | Name and birth year, plus a one-way reference hash, **never** the Aadhaar number (L-21) | Usually needs the company first. |
| Liveness / face match | The same KYC provider | Replaces the mock face embeddings | L-20, L-33 consent wording. |
| SMS | MSG91: **test credits** | OTP and essential messages | Needs **DLT** registration of the sender ID and every template (L-29). |
| WhatsApp | Gupshup (or another BSP): **sandbox** | Opt-in updates | Needs a WhatsApp Business account with approved templates. |
| Play Integrity | Google Play Console | Real device-integrity verdicts | Needs the Play developer account. |
| GSTN check | A GSP or KYC vendor's GSTIN API: sandbox | Business verification | |

When you're ready for a vendor, tell me which one, and I'll tell you exactly which plan to pick and which keys go into `.env`. You paste the keys yourself.

## 2. Infrastructure (plan only, not deployed)
- **Region:** AWS Mumbai (`ap-south-1`) for everything, because payment data must stay in India (L-24).
- **Database:** RDS Postgres 16 with PostGIS and pgvector, Multi-AZ, encrypted, and automated backups with point-in-time recovery (PITR) for 35 days.
  - Run migrations as the **owner** role.
  - Run the app as **`shiftkart_app`** (migration 007); the API refuses to start as the owner.
- **API:** 2+ containers (ECS Fargate) behind an ALB with `TRUST_PROXY=1`, WAF in front, and HTTPS only.
  - Background jobs currently run in-process on every instance. They are safe to run concurrently (`SKIP LOCKED` and idempotent), but a single job instance is tidier.
- **Web apps:** Next.js on the same cluster, or a static/edge host in India.
- **Secrets:**
  - AWS Secrets Manager for `DATA_KEY`, `HASH_KEY`, provider keys and DB passwords;
  - rotate them on staff exit;
  - write the `DATA_KEY` rotation runbook before launch (re-encrypt in batches with a key ID).
- **Monitoring:**
  - error rate, p95 latency, job lag, payout failures, reconciliation mismatches, OTP send failures, SOS events (paged);
  - logs to CloudWatch, already PII-masked.
- **Backups:**
  - restore drill once before launch, then quarterly;
  - deletion requests must survive restores (re-apply deletions from the audit log after a restore).

## 3. Before real users
- [ ] Pen test of staging (SECURITY_REVIEW.md, still to do).
- [x] zod 4 upgrade (S-09).
- [ ] Expo upgrade (S-10).
- [ ] Load test re-run against staging (LOAD_TEST.md).
- [ ] Breach tabletop exercise (BREACH_RESPONSE.md).
- [ ] Final consent texts and privacy notice from the lawyer replace the `draft-0` placeholders (`CONSENT_VERSION`).
- [ ] Real minimum-wage table entered and checked (L-04); the seed is a sample.
- [ ] Tax settings confirmed (GST, TDS, welfare fees: L-02, L-03, L-12, L-13).
- [ ] Play Store listing, data-safety form, and Play Integrity turned on.
- [ ] Support rota for SOS and disputes (24×7 for SOS during shift hours).
- [ ] A small pilot: a few friendly businesses, real shifts, limits kept low (`payout.daily_cap_paise`).

## 4. Switching one service from sandbox to live
Do one provider at a time, each with your explicit "go live with X" in chat.

1. The sandbox integration has passed its tests and a manual run on staging.
2. You create the live account, complete the vendor's KYC, and paste the live keys into the **production** secret store yourself. I never see or handle them.
3. Set the provider's switch for that provider only:
   - for messages, `ALLOW_REAL_MESSAGES=true` (exists today);
   - for payments, payouts and KYC, the equivalent switch is added together with each real adapter (only mocks exist today);
   - a canary limit: low payout caps, and a first-day allowlist of pilot businesses.
4. Run one small real transaction end to end, for example ₹1 funding, then a refund, then a ₹1 payout to your own UPI, and check:
   - the reconciliation;
   - the ledger;
   - the vendor dashboard.
5. Watch the alerts for 24 hours, then raise the limits step by step.
6. **Rollback:** set the provider back to `mock` / sandbox, or set `payouts.paused = true`. Queued work waits; nothing is lost.
