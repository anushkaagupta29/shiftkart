# Legal checklist — to confirm with a lawyer

Nothing in this repo is legal advice or final legal text. Each item is something the system makes **configurable**. A lawyer needs to confirm the right values or approach before go-live. Status: ☐ open · ◐ **assumed** (the owner accepted the default below on 2026-10-24; a lawyer has **not** confirmed it) · ☑ confirmed by a lawyer.

## Business model and labour
- ◐ **L-01** Marketplace vs. staffing agency / employer of record: who is the employer, and is a contract-labour licence needed (Contract Labour Act / OSH Code)? Affects invoicing, GST base and liability.
- ◐ **L-02** Code on Social Security 2020, gig/platform worker provisions: is ShiftKart an "aggregator"? What is the welfare contribution rate and base? Config: `welfare.central_bp` (default 0). Charged to the business, never deducted from workers (D-090).
- ◐ **L-03** Karnataka Platform-based Gig Workers (Social Security and Welfare) Act: does it apply? What welfare fee, registration and reporting? Config: `welfare.state_bp` with scope `state:KA` (default 0) (D-090). Removal of a worker needs written reasons and 14 days' notice: built (D-091), `removal.notice_days`. To confirm: may a safety incident justify an interim hold during the notice?
- ◐ **L-04** Minimum wages per Karnataka schedule, skill level and zone, including VDA revision dates. Seed data is **sample only**.
- ◐ **L-05** Working hours, overtime rate (we assume 2×), rest gap, daily and weekly caps.
- ◐ **L-06** Night work and women workers: Karnataka Shops & Establishments rules on hours, consent, transport and minimum numbers.
- ◐ **L-07** Late-cancellation and turn-away compensation amounts: any legal minimum (e.g. reporting-time pay)?
- ◐ **L-08** Whether gender-specific requirements are ever permissible, and for which roles.
- ◐ **L-09** Prohibited and hazardous role list; minimum age above 18 for any role.
- ◐ **L-10** Strike, suspension and appeal policy: fairness and grievance obligations.
- ◐ **L-11** Full-time conversion fee: enforceability, and that it never binds the worker.
- ◐ **L-35** Statutory records under the Code on Wages / OSH Code (muster roll, wage register, wage slips): whose duty in the marketplace model, and whether our attendance records, timesheets and payslips meet the required format and retention.
- ◐ **L-37** Sexual harassment (POSH Act 2013): who must run the Internal/Local Committee for workers placed through us; how our incident flow hands over to it; timelines.
- ◐ **L-38** Strike, limit and suspension rules and the appeal process (D-062, D-063): fairness and any notice requirements; compensation percentages for late cancellation and turn-away (D-061).
- ◐ **L-36** Allowances paid in full for a partial day (D-051), the pro-rata unpaid break (D-049), and "no pay for early arrival / staying late without agreed overtime": confirm these rules are lawful.

## Tax
- ◐ **L-12** GST on platform fee: rate, SAC code, place of supply (CGST/SGST vs IGST), invoice format and numbering.
- ◐ **L-13** TDS: who deducts on worker payments (business under 194C? platform under 194-O?), thresholds, PAN collection from workers. Not built yet (no deduction, no PAN collected).
- ◐ **L-14** TCS or other e-commerce operator obligations.

## Payments
- ◐ **L-15** Holding business funds: needs an RBI-authorised payment aggregator's escrow or nodal account. Confirm the structure with the chosen provider.
- ◐ **L-16** Refund timelines, chargeback handling, and the non-refundable gateway cost disclosure.
- ◐ **L-17** AML / suspicious-transaction obligations (PMLA), and payout caps.

## Data protection (DPDP Act 2023 + Rules)
- ◐ **L-18** Consent notice text per purpose, in Hindi, English and Kannada.
- ◐ **L-19** Retention periods in SPEC §6.12, and keeping fraud-prevention hashes after deletion.
- ◐ **L-20** Face embeddings and selfies: lawful basis, retention, and whether consent is enough.
- ◐ **L-21** Aadhaar handling: using DigiLocker / a licensed KYC provider, never storing the number. Confirm the Aadhaar Act / UIDAI rules for our flow.
- ◐ **L-22** Grievance officer (named person), response timelines, contact display.
- ◐ **L-23** Breach response plan: notify the Data Protection Board and users within the required time.
- ◐ **L-24** Data localisation (payment data must stay in India under RBI rules).
- ◐ **L-25** Location tracking during shifts: consent and limits.
- ◐ **L-26** Children's data: confirm age-gating is enough.
- ◐ **L-33** Face templates kept for the life of the account and searched across accounts to catch duplicates: lawful basis, consent wording, retention, and whether the search itself needs separate consent.
- ◐ **L-39** Scanning chat messages for scams, keeping blocked originals encrypted, and chat retention (1 year): consent and notice wording.
- ◐ **L-40** SOS location sharing with a trusted contact: consent and retention of location trails.
- ◐ **L-41** Deleting an account while suspended or limited keeps the phone hash and KYC identity hash, so the person can't re-register (D-083). Is this a legitimate use?
- ◐ **L-42** Is the JSON data export enough for the right of access, or is a readable PDF also needed (D-082)?
- ◐ **L-43** Deletion removes contact details, name, face template and payout details at once (stricter than SPEC's "+180 days"). Attendance location, chat and pay records are kept to their retention dates. Confirm this split and the 8-year purge for financial records.
- ◐ **L-34** Language requirements on shifts: confirm they're acceptable as job requirements and not an indirect proxy for region or community (BIZ-07).

## Platform
- ◐ **L-27** Terms of service, privacy policy, worker agreement, business agreement. **To be drafted by a lawyer.** Placeholders in the app say "DRAFT — not final".
- ◐ **L-28** IT Act intermediary obligations (grievance, takedown) for chat and listings.
- ◐ **L-29** Masked calling and call-recording consent (if recorded). Telecom/TRAI rules on commercial SMS/WhatsApp: DLT registration of the sender and every template (`apps/api/src/notify/templates.ts`), quiet hours, WhatsApp opt-in wording.
- ◐ **L-30** Trademark search for the name "ShiftKart" (closeness to "Flipkart").
- ◐ **L-31** Process for indicators of bonded labour or trafficking; reporting to authorities.
- ◐ **L-32** Company registration, plus any state registration as a platform/aggregator.

## Working assumptions (owner accepted the defaults, 2026-10-24, D-089)
These are what the system is built on today. **They are not legal conclusions.** Each item stays ◐ until a lawyer confirms or corrects it; nothing goes live on an assumption.

| ID | Working assumption |
|---|---|
| L-01 | Marketplace. The business is the employer; ShiftKart invoices only its fee plus GST on the fee. |
| L-02, L-03 | Welfare contributions apply to us as an aggregator. **Paid by the business on top, never deducted from the worker.** Charged on worker pay (base plus overtime, not allowances), shown as its own non-GST invoice line, held in `welfare_payable:*` accounts. Built (D-090) with rate 0 until the lawyer gives the rate and basis. Removing a worker takes written reasons and 14 days' notice (D-091); an interim safety hold during the notice is assumed allowed. |
| L-04 | The seeded Karnataka minimum wages are samples. Real rates are entered and checked before launch; posting below the rate stays blocked. |
| L-05, L-36 | 2× overtime; 8 h rest gap; 12 h per day; allowances in full for a partial day; pro-rata unpaid break; no pay for unagreed early arrival or staying late. |
| L-06 | Night window 20:00–06:00. The business must promise transport, and every worker gives explicit consent (no gender-based rules, since we don't store gender). |
| L-07, L-38 | The cancellation and turn-away compensation defaults in SPEC §6.7; strikes expire after 90 days and can be appealed. |
| L-08 | No gender-specific requirements on shifts. |
| L-09 | 18+ for all roles; hazardous roles are not allowed on the platform. |
| L-10 | Suspensions always come with a reason and an appeal reviewed by a person. |
| L-11 | The full-time hire fee is paid by the business only, after the worker agrees; it never binds the worker. |
| L-12 | 18% GST on our fee; place of supply Karnataka (CGST + SGST). |
| L-13 | No TDS deducted for now, and no PAN collected. To be built if the lawyer says we or the business must deduct. |
| L-14 | No TCS for now. |
| L-15 | Business money is held through an RBI-authorised payment aggregator's escrow or nodal account, never ShiftKart's own bank account. |
| L-16 | Refunds go back to the original payment method; non-refundable gateway costs are shown before payment. |
| L-17 | Daily and monthly payout caps, plus fraud flags, are enough until PMLA duties are confirmed. |
| L-18 | One consent per purpose, in en/hi/kn. Texts stay `draft-0` placeholders until the lawyer writes them. |
| L-19, L-43 | Retention as listed in LEGAL_REVIEW.md. Personal details are removed at once on deletion; pay records are kept for 8 years; fraud-prevention hashes are kept. |
| L-20, L-33 | Explicit consent is enough for face templates and the duplicate search; templates are removed on deletion. |
| L-21 | DigiLocker or a licensed KYC provider; we keep only name, birth year and a hashed reference, never the Aadhaar number or an image. |
| L-22 | A named grievance officer, shown in the apps; production won't start without one. |
| L-23 | The timelines in BREACH_RESPONSE.md (CERT-In within 6 h; the Data Protection Board and users without delay; a detailed report within 72 h). |
| L-24 | All data hosted in India (AWS Mumbai). |
| L-25, L-40 | Location only at check-in and check-out, plus optional pings during shifts, with consent; SOS trails deleted 90 days after resolution. |
| L-26 | An 18+ age check via KYC is enough; we don't knowingly process children's data. |
| L-27 | Terms, privacy notice and both agreements to be drafted by a lawyer; the apps say DRAFT until then. |
| L-28 | We act as an intermediary for chat and listings: a grievance contact plus takedown through ops. |
| L-29 | DLT registration for the sender and every SMS template; WhatsApp only after opt-in; calls are not recorded. |
| L-30 | The name "ShiftKart" is a working title until a trademark search is done. |
| L-31 | Signs of bonded labour or trafficking are escalated to ops and reported to the authorities. |
| L-32 | No company is registered yet. Real vendors (payments, DLT, WhatsApp, KYC, Play Store) wait for one. |
| L-34 | Language requirements are allowed where the job needs them. **Gap:** today any business can set up to 5 languages without giving a reason; ops review it under BIZ-07. |
| L-35 | The business keeps the statutory registers as the employer; our records support them. |
| L-37 | The business's POSH committee handles complaints. **Gap:** the incident flow doesn't hand over to it yet; ops do that by hand. |
| L-39 | Notice covers the chat scanning; blocked originals are kept encrypted; chat text is removed after 1 year. |
| L-41 | Keeping hashes to block re-registration after deletion while restricted is a legitimate use. |
| L-42 | A JSON export is enough for now; a readable PDF is added if the lawyer asks for it. |

