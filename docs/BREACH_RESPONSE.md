# Personal data breach response plan

> **DRAFT. Not legal advice.**
> - The timelines below are my reading of the DPDP Act 2023, the DPDP Rules, and the CERT-In directions (April 2022).
> - A lawyer must confirm them before launch (LEGAL_CHECKLIST L-23).
> - Names in brackets are roles to fill.

## What counts
Any unauthorised access to, or loss, change or disclosure of, personal data. Examples:
- a leaked database dump or backup;
- a stolen staff laptop with exports;
- an API bug that shows one worker another worker's data;
- a vendor (KYC, SMS, payments) telling us they were breached;
- a staff member reading records without a reason (the INT-05 flag).

## Who
| Role | Does |
|---|---|
| **Incident lead** [founder / on-call engineer] | Runs the response; keeps the timeline. |
| **Grievance officer / DPO** [to be appointed, L-22] | Notices to the Data Protection Board and to affected people. |
| **Lawyer** [external] | Confirms what must be reported, by when, and to whom. |
| **Vendors** | Payment aggregator, KYC, SMS/WhatsApp, cloud: their security contacts are listed in the on-call doc. |

## Timeline (to confirm, L-23)
| When | What |
|---|---|
| **0 h** (we become aware) | Open an incident record (time, who noticed, what is known). Start the log below. |
| **≤ 6 h** | **CERT-In report** for reportable cyber incidents (CERT-In directions, 28 April 2022). |
| **Without delay** | **Intimation to the Data Protection Board** (DPDP Rules): nature, extent, timing, likely impact. |
| **Without delay** | **Notice to each affected person**: what happened, what data, likely consequences, what we did, what they can do, and who to contact. In their app language (en/hi/kn), by SMS plus an in-app banner. |
| **≤ 72 h** (or longer if the Board allows) | **Detailed report to the Board**: facts, cause, mitigation, people notified, and measures to prevent recurrence. |

## First hour: contain
1. **Stop the leak:**
   - revoke the keys involved;
   - rotate `DATA_KEY` / `HASH_KEY` if they could be exposed (runbook in GO_LIVE.md);
   - block the account/IP;
   - turn off the affected route (feature flag or deploy).
2. **Sign everyone out if sessions could be stolen:**
   ```sql
   UPDATE sessions SET revoked_at = now(), revoke_reason = 'incident';
   UPDATE staff_sessions SET revoked_at = now();
   ```
3. **Pause payouts if money could be affected:** set policy `payouts.paused = true` (admin console → Policies; needs two people).
4. **Preserve evidence:**
   - snapshot the database;
   - keep the logs (they are PII-masked, so they can be shared with investigators).
   - **Do not** edit the audit log; it is hash-chained, and `/admin/audit/verify` proves nothing was altered.

## Work out the scope
- Use the audit log: who read what, and when (`audit_log`, filter by actor and time). Staff record reads are logged.
- Check what was encrypted at rest. A dump without `DATA_KEY` exposes only:
  - phone **hashes** and last 4 digits;
  - first names;
  - coarse data.
- Note what we never had. We never store:
  - Aadhaar numbers or ID images;
  - full card details;
  - passwords for workers or businesses.
- List affected users. The export code (`apps/api/src/privacy.ts`) shows every table that holds a user's data.

## Afterwards
- A post-mortem within 7 days: cause, timeline, what worked, and fixes with owners.
- Add a regression test or abuse case for the cause.
- Update this plan.

## Practice
Run a tabletop exercise before launch, then every 6 months. Scenario idea: "a staff laptop with a CSV export is stolen".
