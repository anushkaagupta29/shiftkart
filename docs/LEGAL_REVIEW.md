# Legal review pack: for you and a lawyer

> - This is not legal advice. It is a working list for a lawyer meeting, built from `LEGAL_CHECKLIST.md`.
> - For each item it says what the system does today, where the setting lives, and what we need back.
> - **Nothing is confirmed yet.** On 2026-10-24 the owner accepted my default answers as working assumptions (◐, listed at the end of `LEGAL_CHECKLIST.md`, D-089). They are what the system is built on, **not** legal conclusions. Each item becomes ☑ only when a lawyer confirms it.

## Priority 1: blocks any launch (decides how the business is set up)
| ID | Question for the lawyer | What the code does now | Where to change it |
|---|---|---|---|
| L-01 | Are we a marketplace, or the employer / contractor of record? Do we need a contract-labour licence? | The marketplace model: the business is the employer, and we invoice only our fee plus GST. | Invoicing (`money.ts`); a different model changes money flows. |
| L-15 | Escrow structure: which RBI-authorised PA holds business money, and how? | A per-shift escrow account in our own ledger (mock). | Payment adapter + ledger accounts. |
| L-27 | Terms of service, privacy notice, worker and business agreements | Placeholders saying "DRAFT — not final"; consent version `draft-0`. | `CONSENT_VERSION` in `auth/otp.ts`; app copy. |
| L-32 | Company registration; any state aggregator registration | None. | — |
| L-02, L-03 | Gig-worker social security: Central Code, and the Karnataka Platform-based Gig Workers Act: rates, registration, reporting | Built (D-090): charged to the business on top of worker pay and never deducted from workers; on the invoice as its own line with no GST. **Rate 0 until confirmed.** | `welfare.central_bp`, `welfare.state_bp` (scope `state:KA`) |
| L-21 | Aadhaar via DigiLocker / a licensed KYC provider, never storing the number: is our flow compliant? | Only name, birth year and a one-way reference hash are kept. | `routes/worker.ts` (KYC complete). |

## Priority 2: needed before real money and real workers
| ID | Question | Now | Setting |
|---|---|---|---|
| L-04 | Correct Karnataka minimum wages per skill and zone, and the VDA dates | Sample rates; posting below the rate is blocked. | Admin → minimum wages |
| L-05, L-36 | Overtime rate, rest gap, daily/weekly caps; the allowance and break rules | 2× overtime, 8 h rest, 12 h/day. | `overtime.multiplier_bp`, `booking.*` policies |
| L-06 | Night work rules (incl. women workers): hours, transport, consent | 20:00–06:00 window; transport attestation plus consent from every worker. | `night.*` policies (per state scope) |
| L-07, L-38 | Late-cancel / turn-away compensation amounts; strike and suspension fairness and notice | Defaults in SPEC §6.7. | `cancel.*`, `strikes.*` policies |
| L-12, L-13, L-14 | GST on fee (SAC, place of supply); TDS (194C / 194-O?) and PAN; TCS | 18% GST on fee (`tax.gst_on_fee_bp`). **TDS not built**: no deduction, no PAN collected. | To add once confirmed. |
| L-16, L-17 | Refund timelines, chargebacks; AML / payout caps | Daily/monthly payout caps; refunds back to source. | `payout.*_cap_paise` |
| L-35 | Statutory registers (muster roll, wage register, wage slips): our job or the business's? Is our format OK? | Attendance events, timesheets and payslips are kept append-only. | — |
| L-37 | POSH: who runs the committee for placed workers; how our incident flow hands over | Incident reports go to ops; no committee hand-off yet. | `cases.ts` |

## Priority 3: data protection (DPDP), needed before launch
| ID | Question | Now | Setting |
|---|---|---|---|
| L-18 | Final consent notice text per purpose, in en/hi/kn | Purposes: account, location at shift, face verification, notifications. Each one except "account" can be withdrawn in the app. | `consents` table; app strings |
| L-19 | Retention periods; keeping fraud-prevention hashes after deletion | See the table below. | `retention.*` policies |
| L-20, L-33 | Face templates: lawful basis, whether a cross-account duplicate search needs separate consent, retention | Kept for the life of the account; removed on deletion; withdrawing consent blocks check-in. | — |
| L-22 | The grievance officer: a named person, response times | Placeholder shown in the apps; production won't start without it. | `GRIEVANCE_OFFICER_*` env |
| L-23 | Breach timelines (Board, CERT-In, users) | The plan in `BREACH_RESPONSE.md`. | — |
| L-25, L-40 | Location during shifts; SOS trail sharing | Optional pings with consent; SOS trail deleted 90 days after resolution. | `retention.sos_location_days` |
| L-39 | Chat scanning and keeping blocked originals | Originals encrypted; chat text removed after 1 year. | `retention.messages_days` |
| L-41 *(new)* | Deleting an account while suspended/limited keeps the phone and identity hashes, so the person can't sign up again. Is that a legitimate use? | Yes as implemented (D-083). | `privacy.ts` |
| L-42 *(new)* | Is a JSON export enough for the access right, or do we also need a readable PDF? | JSON only (D-082). | `/me/export` |

**Retention as implemented** (all configurable, daily job):
| Data | Kept | On account deletion |
|---|---|---|
| Phone, name, face template, payout details, trusted contact | Account life | Removed at once (stricter than SPEC's "+180 days"; confirm) |
| Location on attendance records | 1 year, then blanked (the record itself stays) | Kept until the 1-year mark (the attendance record is a pay record) |
| In-shift location pings | 1 year | Kept until 1 year |
| Chat text | 1 year, then replaced with "[removed]" | Kept until 1 year (disputes) |
| Notification records | 90 days | Pending ones cancelled |
| SOS location trail | 90 days after resolution | Deleted at once |
| OTP records | 30 days | — |
| Timesheets, payslips, ledger, invoices, audit log | Not deleted (database role can't) | Kept: 8 years (L-19 to confirm; a purge job is needed before year 8) |

## Priority 4: before scaling
L-08, L-09 (gender and age rules per role), L-10 and L-11 (strikes; the full-time hire fee never binding the worker), L-24 (data localisation for the hosting choice), L-26 (age-gating), L-28 (IT Act intermediary duties), L-29 (DLT, call masking), L-30 (trademark), L-31 (bonded labour / trafficking reporting), L-34 (language requirements on shifts).

## What I need back from you after the lawyer meeting
For each ID: ☑ the assumption is confirmed (with the value, if it's a setting), or ✎ the assumption is wrong (what it should be). I'll update the settings, `LEGAL_CHECKLIST.md` and DECISIONS, and add tests where a rule changes.
