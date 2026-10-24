# Legal checklist — to confirm with a lawyer

Nothing in this repo is legal advice or final legal text. Each item is something the system makes **configurable**. A lawyer needs to confirm the right values or approach before go-live. Status: ☐ open · ◐ discussed · ☑ confirmed.

## Business model and labour
- ☐ **L-01** Marketplace vs. staffing agency / employer of record: who is the employer, and is a contract-labour licence needed (Contract Labour Act / OSH Code)? Affects invoicing, GST base and liability.
- ☐ **L-02** Code on Social Security 2020, gig/platform worker provisions: is ShiftKart an "aggregator"? What is the welfare contribution rate and base? Not built yet (no deduction); to be added as a setting once confirmed.
- ☐ **L-03** Karnataka Platform-based Gig Workers (Social Security and Welfare) Act: does it apply? What welfare fee, registration and reporting? Not built yet.
- ☐ **L-04** Minimum wages per Karnataka schedule, skill level and zone, including VDA revision dates. Seed data is **sample only**.
- ☐ **L-05** Working hours, overtime rate (we assume 2×), rest gap, daily and weekly caps.
- ☐ **L-06** Night work and women workers: Karnataka Shops & Establishments rules on hours, consent, transport and minimum numbers.
- ☐ **L-07** Late-cancellation and turn-away compensation amounts: any legal minimum (e.g. reporting-time pay)?
- ☐ **L-08** Whether gender-specific requirements are ever permissible, and for which roles.
- ☐ **L-09** Prohibited and hazardous role list; minimum age above 18 for any role.
- ☐ **L-10** Strike, suspension and appeal policy: fairness and grievance obligations.
- ☐ **L-11** Full-time conversion fee: enforceability, and that it never binds the worker.
- ☐ **L-35** Statutory records under the Code on Wages / OSH Code (muster roll, wage register, wage slips): whose duty in the marketplace model, and whether our attendance records, timesheets and payslips meet the required format and retention.
- ☐ **L-37** Sexual harassment (POSH Act 2013): who must run the Internal/Local Committee for workers placed through us; how our incident flow hands over to it; timelines.
- ☐ **L-38** Strike, limit and suspension rules and the appeal process (D-062, D-063): fairness and any notice requirements; compensation percentages for late cancellation and turn-away (D-061).
- ☐ **L-36** Allowances paid in full for a partial day (D-051), the pro-rata unpaid break (D-049), and "no pay for early arrival / staying late without agreed overtime": confirm these rules are lawful.

## Tax
- ☐ **L-12** GST on platform fee: rate, SAC code, place of supply (CGST/SGST vs IGST), invoice format and numbering.
- ☐ **L-13** TDS: who deducts on worker payments (business under 194C? platform under 194-O?), thresholds, PAN collection from workers. Not built yet (no deduction, no PAN collected).
- ☐ **L-14** TCS or other e-commerce operator obligations.

## Payments
- ☐ **L-15** Holding business funds: needs an RBI-authorised payment aggregator's escrow or nodal account. Confirm the structure with the chosen provider.
- ☐ **L-16** Refund timelines, chargeback handling, and the non-refundable gateway cost disclosure.
- ☐ **L-17** AML / suspicious-transaction obligations (PMLA), and payout caps.

## Data protection (DPDP Act 2023 + Rules)
- ☐ **L-18** Consent notice text per purpose, in Hindi, English and Kannada.
- ☐ **L-19** Retention periods in SPEC §6.12, and keeping fraud-prevention hashes after deletion.
- ☐ **L-20** Face embeddings and selfies: lawful basis, retention, and whether consent is enough.
- ☐ **L-21** Aadhaar handling: using DigiLocker / a licensed KYC provider, never storing the number. Confirm the Aadhaar Act / UIDAI rules for our flow.
- ☐ **L-22** Grievance officer (named person), response timelines, contact display.
- ☐ **L-23** Breach response plan: notify the Data Protection Board and users within the required time.
- ☐ **L-24** Data localisation (payment data must stay in India under RBI rules).
- ☐ **L-25** Location tracking during shifts: consent and limits.
- ☐ **L-26** Children's data: confirm age-gating is enough.
- ☐ **L-33** Face templates kept for the life of the account and searched across accounts to catch duplicates: lawful basis, consent wording, retention, and whether the search itself needs separate consent.
- ☐ **L-39** Scanning chat messages for scams, keeping blocked originals encrypted, and chat retention (1 year): consent and notice wording.
- ☐ **L-40** SOS location sharing with a trusted contact: consent and retention of location trails.
- ☐ **L-41** Deleting an account while suspended or limited keeps the phone hash and KYC identity hash, so the person can't re-register (D-083). Is this a legitimate use?
- ☐ **L-42** Is the JSON data export enough for the right of access, or is a readable PDF also needed (D-082)?
- ☐ **L-43** Deletion removes contact details, name, face template and payout details at once (stricter than SPEC's "+180 days"). Attendance location, chat and pay records are kept to their retention dates. Confirm this split and the 8-year purge for financial records.
- ☐ **L-34** Language requirements on shifts: confirm they're acceptable as job requirements and not an indirect proxy for region or community (BIZ-07).

## Platform
- ☐ **L-27** Terms of service, privacy policy, worker agreement, business agreement. **To be drafted by a lawyer.** Placeholders in the app say "DRAFT — not final".
- ☐ **L-28** IT Act intermediary obligations (grievance, takedown) for chat and listings.
- ☐ **L-29** Masked calling and call-recording consent (if recorded). Telecom/TRAI rules on commercial SMS/WhatsApp: DLT registration of the sender and every template (`apps/api/src/notify/templates.ts`), quiet hours, WhatsApp opt-in wording.
- ☐ **L-30** Trademark search for the name "ShiftKart" (closeness to "Flipkart").
- ☐ **L-31** Process for indicators of bonded labour or trafficking; reporting to authorities.
- ☐ **L-32** Company registration, plus any state registration as a platform/aggregator.
