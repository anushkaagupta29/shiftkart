# Security review (Phase 6)

Scope:
- the API (`apps/api`);
- the business and admin web apps;
- the worker app;
- database roles and triggers;
- dependencies;
- configuration.

Method:
- read every route and query;
- the OWASP Top 10 test suite (`test/security/owasp.test.ts`);
- the route × role matrix (`test/security/rbac-matrix.test.ts`);
- the abuse tests;
- `npm audit`;
- a secrets scan of tracked files.

This is a self-review by the person who wrote the code. **A professional penetration test is still needed before launch** (GO_LIVE.md).

## Findings and what was done

| # | Finding | Severity | Status |
|---|---|---|---|
| S-01 | The app connected to Postgres as the table **owner**. A SQL-injection or a compromised API box could `DISABLE TRIGGER` and rewrite the audit log or ledger. | High | **Fixed.** Migration 007 adds the `shiftkart_app` role: it can read and write rows, but cannot UPDATE/DELETE history tables, TRUNCATE, ALTER or DROP. In production the API refuses to start if it connects as the owner. Tested. |
| S-02 | Behind a load balancer every request would look like it came from one IP, so per-IP OTP limits would either block everyone or nobody. Blindly trusting `X-Forwarded-For` would let attackers pick their own IP. | High | **Fixed.** `TRUST_PROXY=<hops>` trusts exactly that many proxies; the default is none. Tests: spoofed headers are ignored without it, and real clients are separated with it. |
| S-03 | New staff accounts kept the one-time password shown at creation. | Medium | **Fixed.** Staff must change it at first login (12+ characters, letters and numbers). Changing it ends their other sessions and is audited. |
| S-04 | The web apps sent no CSP or anti-framing headers (the API had them via helmet). | Medium | **Fixed.** CSP with `connect-src` limited to the API, `frame-ancestors 'none'`, `X-Frame-Options`, nosniff, Referrer-Policy, Permissions-Policy, and HSTS in production. |
| S-05 | Production could start with unsafe settings (http URLs, local DB, no proxy setting, huge rate limits, no grievance officer). | Medium | **Fixed.** `productionProblems()` lists them and the server refuses to start. |
| S-06 | DPDP rights (export, erasure, consent withdrawal, retention) were specified but not built. | High (legal) | **Fixed.** See D-082 to D-085. Tests in `test/integration/data-rights.test.ts`. |
| S-07 | Deleting an account could have been used to escape strikes or a suspension (sign up again clean). | Medium | **Fixed.** Deleting while restricted keeps the number and identity hashes blocking. Tested (WRK-07). |
| S-08 | `fast-uri` (inside Fastify's validator) and `uuid` had advisories. | Moderate | **Fixed** with `npm audit fix` (patch versions, no new packages). |
| S-09 | `zod` < 4.6.6: memory exhaustion on oversized constrained collections (GHSA-mrhx-c7xc-m3w5). | High upstream, low here (all schemas bounded, 100 KB body cap) | **Fixed.** The API is on zod 4.6.7 (D-088). `npm audit` still lists zod 3 because `@expo/cli` bundles its own copy; that's a build tool, covered by S-10. |
| S-10 | `expo` / `@expo/cli` / `node-forge` / `xcode` advisories. | High upstream, **not in production code** | **Accepted (D-030).** These are build-machine tools; none ships in the app bundle or the API. The fix is a newer Expo major. Revisit when upgrading Expo. |

## Checked, no change needed
- **SQL injection:** every query is parameterised. The few interpolated fragments are compile-time constants (table lists in tests, column lists).
- **Secrets:** none in tracked files. `.env` is git-ignored; data keys and HMAC keys come from the environment; at rest, phones, names, payout details and chat originals are encrypted with AES-256-GCM.
- **Authentication:**
  - OTPs are hashed, expire after 5 minutes, allow 5 attempts, and are rate-limited per phone, per IP and globally;
  - sessions are opaque hashed tokens with rotating refresh (reuse revokes the whole family);
  - staff log in with scrypt plus TOTP and an HttpOnly, SameSite=Strict cookie.
- **Authorisation:** deny by default; every route declares who may call it; the matrix test proves it for all roles; business data is scoped by membership; workers can only see their own data.
- **Money:**
  - integer paise;
  - idempotency keys on every payment/payout call;
  - webhook HMAC with replay protection;
  - double-entry ledger with append-only triggers;
  - daily reconciliation;
  - four-eyes approval for manual payouts.
- **Logging:** a PII-masking logger, tested; no request bodies are logged.
- **Dev endpoints:** never registered in production (tested).

## Still to do before launch (also in GO_LIVE.md)
1. Professional penetration test of the deployed staging environment.
2. Upgrade to a newer Expo (S-10).
3. Turn on Play Integrity for real (the mock verdict is only for testing).
4. Secret storage in a managed vault (AWS Secrets Manager / KMS) and key rotation runbook.
5. WAF and DDoS protection in front of the API.
