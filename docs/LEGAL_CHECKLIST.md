# Legal checklist — to confirm with a lawyer

Nothing in this repo is legal advice or final legal text. Each item is something the system makes **configurable**. A lawyer needs to confirm the right values or approach before go-live. Status: ☐ open · ◐ discussed · ☑ confirmed.

## Business model and labour
- ☐ **L-01** Marketplace vs. staffing agency / employer of record: who is the employer, and is a contract-labour licence needed (Contract Labour Act / OSH Code)? Affects invoicing, GST base and liability.
- ☐ **L-02** Code on Social Security 2020, gig/platform worker provisions: is ShiftKart an "aggregator"? What is the welfare contribution rate and base? Config: `welfare.central.rate`.
- ☐ **L-03** Karnataka Platform-based Gig Workers (Social Security and Welfare) Act: does it apply? What welfare fee, registration and reporting? Config: `welfare.KA.*`.
- ☐ **L-04** Minimum wages per Karnataka schedule, skill level and zone, including VDA revision dates. Seed data is **sample only**.
- ☐ **L-05** Working hours, overtime rate (we assume 2×), rest gap, daily and weekly caps.
- ☐ **L-06** Night work and women workers: Karnataka Shops & Establishments rules on hours, consent, transport and minimum numbers.
- ☐ **L-07** Late-cancellation and turn-away compensation amounts: any legal minimum (e.g. reporting-time pay)?
- ☐ **L-08** Whether gender-specific requirements are ever permissible, and for which roles.
- ☐ **L-09** Prohibited and hazardous role list; minimum age above 18 for any role.
- ☐ **L-10** Strike, suspension and appeal policy: fairness and grievance obligations.
- ☐ **L-11** Full-time conversion fee: enforceability, and that it never binds the worker.

## Tax
- ☐ **L-12** GST on platform fee: rate, SAC code, place of supply (CGST/SGST vs IGST), invoice format and numbering.
- ☐ **L-13** TDS: who deducts on worker payments (business under 194C? platform under 194-O?), thresholds, PAN collection from workers. Config: `tds.*`.
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

## Platform
- ☐ **L-27** Terms of service, privacy policy, worker agreement, business agreement. **To be drafted by a lawyer.** Placeholders in the app say "DRAFT — not final".
- ☐ **L-28** IT Act intermediary obligations (grievance, takedown) for chat and listings.
- ☐ **L-29** Masked calling and call-recording consent (if recorded). Telecom/TRAI rules on commercial SMS/WhatsApp (DLT registration).
- ☐ **L-30** Trademark search for the name "ShiftKart" (closeness to "Flipkart").
- ☐ **L-31** Process for indicators of bonded labour or trafficking; reporting to authorities.
- ☐ **L-32** Company registration, plus any state registration as a platform/aggregator.
