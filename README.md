# ShiftKart

Short-shift staffing for India: businesses post pre-funded shifts, verified workers pick them,
check in on site, and get paid within a day. **Status: Phase 1 (foundation).** Everything runs on your
laptop. Nothing talks to a real SMS, payment or KYC service: those are all mocks.

- Product spec: [docs/SPEC.md](docs/SPEC.md)
- Abuse cases and their tests: [docs/ABUSE_CASES.md](docs/ABUSE_CASES.md)
- Decisions and assumptions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Items to confirm with a lawyer: [docs/LEGAL_CHECKLIST.md](docs/LEGAL_CHECKLIST.md)

## What you need

- **Node.js 20.12 or newer** (`node -v` to check)
- **Docker Desktop**, open and running (it runs the database)

## First-time setup

From this folder, in a terminal:

```bash
npm install
```

```bash
npm run setup
```

`setup` creates your private `.env` file with random keys, starts Postgres in Docker, creates the
tables and adds sample data. It's safe to run again.

## Run it

```bash
npm run dev
```

- API: http://localhost:4000 (check: http://localhost:4000/health)
- Admin console: http://localhost:3001

Stop with `Ctrl+C`. The database keeps running in Docker; stop it with `npm run db:down`.

## Log in to the admin console

Seeded staff accounts, one per role:

| Email | Role | Can |
|---|---|---|
| super@shiftkart.local | super_admin | Manage staff, read audit log |
| support@shiftkart.local | ops_support | See users (phones masked) |
| verifier@shiftkart.local | ops_verifier | See users (verification queues come in Phase 2) |
| disputes@shiftkart.local | ops_disputes | See users |
| safety@shiftkart.local | ops_safety | See users, reveal a phone (with a reason), limit/suspend users |
| finance@shiftkart.local | finance | Read policy values (payouts come in Phase 3) |
| compliance@shiftkart.local | compliance | Read audit log and verify it, suspend users, read policy |

- **Password:** the `SEED_STAFF_PASSWORD` line in your `.env` file.
- **2FA code:** staff need a 6-digit code that changes every 30 seconds. Locally you can print it:

```bash
npm run totp -- safety@shiftkart.local
```

### Things to try
1. Log in as **support**. Open Users: phone numbers are masked, and there's no Reveal button.
2. Log in as **safety**. Click a user, try **Reveal phone** without a reason (blocked), then with one.
   Suspend the user with a reason.
3. Log in as **compliance**. Open **Audit log**: your actions are there with who, when and why.
   Click **Verify hash chain**.
4. Log in as **super**. Add a staff member; disable one. Disabled staff are logged out at once.
5. Enter a wrong password 5 times for any account: it locks for 15 minutes.

## Try the worker/business login (API)

There's no worker app until Phase 2, so use the API directly. Seeded sample numbers are
`9000000001` to `9000000003` (workers) and `9000000101` (business owner). They're fake; nothing is sent.

1. Ask for a code:

```bash
curl -s -X POST localhost:4000/auth/otp/request -H 'content-type: application/json' -d '{"phone":"9000000001"}'
```

2. Read the code from the mock SMS outbox (or open **SMS outbox (dev)** in the admin console):

```bash
curl -s -X POST localhost:4000/dev/outbox -H 'content-type: application/json' -d '{"phone":"9000000001"}'
```

3. Log in with that code (replace `123456`):

```bash
curl -s -X POST localhost:4000/auth/otp/verify -H 'content-type: application/json' -d '{"phone":"9000000001","code":"123456","deviceId":"my-laptop-1234"}'
```

You get an `accessToken`. Call `GET /me` with header `Authorization: Bearer <accessToken>`.
For a brand-new number, add `"signup":{"kind":"worker","lang":"hi","consents":["account"]}` to step 3.

## Tests

```bash
npm test
```

Runs unit tests (money, phone, crypto, 2FA) and API tests against a separate test database
(`shiftkart_test`). Abuse-case tests live in `apps/api/test/abuse/`, one file per case ID.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Start API + admin console |
| `npm test` | Run all tests |
| `npm run typecheck` | Type-check every package |
| `npm run db:reset` | **Wipe** the local database and re-seed it |
| `npm run db:down` / `npm run db:up` | Stop / start the local database |
| `npm run totp -- <email>` | Current 2FA code for a local staff account |

## Project layout

```
apps/api        Backend API (Fastify, TypeScript)
apps/admin      Admin console (Next.js)
packages/db     SQL migrations, seed data, migration runner
packages/shared Money, phone, crypto and 2FA helpers shared by everything
infra/          Docker setup for Postgres (with PostGIS + pgvector for later phases)
docs/           Spec, abuse cases, decisions, legal checklist
```

## Troubleshooting

- **"Docker is not running"**: open Docker Desktop and wait until it says it's running.
- **Port already in use**: something else is on 4000, 3001 or 5433. Close it, or change `API_PORT` in `.env`.
- **Admin says "Could not reach the API"**: `npm run dev` isn't running, or the API crashed. Check the terminal.
- **2FA code rejected**: codes change every 30 s and each one works once. Run `npm run totp` again.
