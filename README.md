# ShiftKart

Short-shift staffing for India: businesses post pre-funded shifts, verified workers pick them,
check in on site, and get paid within a day. **Status: Phase 5 (polish for real users) done.** Everything runs
on your laptop. Nothing talks to a real SMS, payment, bank or KYC service: those are all mocks.

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

| What | Where |
|---|---|
| Worker app (Android app, running in the browser for testing) | http://localhost:8081 (open it narrow, or use your browser's phone view) |
| Business web app | http://localhost:3002 |
| Admin console | http://localhost:3001 |
| API | http://localhost:4000 (check: http://localhost:4000/health) |

The first start of the worker app takes a minute while it bundles.

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

## Try the whole flow (Phase 2)

**1. Post and fund a shift as a business** (http://localhost:3002)
- Log in with **9000000101** (the seeded owner of "Demo Warehouse", already verified). Click **Show my code** to see the login code.
- Open Demo Warehouse → **Shifts** → **Post a shift**. Watch the cost update as you type. Try ₹60/hour to see the minimum-wage block.
- Create it, click **Fund**, then **Pay (simulate success)** on the sandbox checkout. The shift is now **live**.
- To try verification from scratch, log in with any new 10-digit number starting 6-9 and create a business.
  For a clean check, name the business **Namma Retail Stores LLP** and use GSTIN `29PQRST5678K1Z2`, PAN `PQRST5678K`
  (they're in the mock GST registry). Any other well-formed GSTIN is "not found", which makes the business
  high-risk: two different verifiers must approve it.

**2. Sign up as a worker** (http://localhost:8081)
- Pick हिंदी or English, enter any new number, tap **Show code (testing only)**, then continue and agree.
- **Identity**: the test DigiLocker screen lets you pick an adult, or an under-18 person to see the age block.
- **Selfie**: "Take selfie" matches. The test buttons show what happens with someone else's face or a photo of a photo.
- **UPI**: any `name@bank` works. Put `mismatch` in it to see a name mismatch, or `partial` to send it to review.
- **Profile**: pick at least one skill. Set distance to **20 km** or more (Whitefield is about 15 km from the city centre).
- The funded shift appears with full pay, time and place. Accept it. It shows up on the business's shift page with your first name.

**3. Work the shift** (check in, break, check out, get paid)

Shifts are usually tomorrow, so there's a dev-only "time machine" that makes a test shift start now:

```bash
curl -s -X POST localhost:4000/dev/shifts/<shift-id>/start-now -H 'content-type: application/json' -d '{"minutes": -5}'
```

(The shift id is in the business app's address bar on the shift page.)
- Business app → the shift → **Open gate screen**. It shows a QR and a 6-digit code that change every 30 seconds,
  and keep working with no internet. On a real phone, put it on the supervisor's phone at the gate.
- Worker app → **My shifts** → the shift. Tap **Test: I am at the site** (stands in for GPS), type the code, **Check in**.
  Try a wrong code, an old code, or the "fake-GPS" and "failed security check" test toggles: the gate screen shows a ⚠.
- Breaks, then check out the same way. To finish the shift in the past, run the curl above with `"minutes": -500`.
- Business app → **Timesheets** → **Approve** (or dispute a few minutes: only those are held).
- Payouts run every 15 seconds (or `curl -X POST localhost:4000/dev/jobs/run`). The worker's **Earnings** tab shows the payslip.
- Two hours after a shift ends it closes: unused money goes back to the business and a GST invoice appears under **Invoices**.

**4. Trust and safety**
- **Chat**: business app → shift → roster → **Chat**; worker app → booking → 💬. Try "send 500 rs fee on gpay" or a
  link: it's blocked and the worker sees a warning. Phone numbers are masked. **Call** gives a masked-number bridge (mock).
- **Cancel a live shift** from the business app: it shows what workers will get first (by how late it is), then pays them from the escrow.
- **Worker cancels late** (less than 12 h before): a strike. **🚑 Emergency** cancels are excused twice in 90 days.
  Worker app → **👤 Me** shows points, rating, strikes (with **Appeal**) and disputes.
- **Safety**: worker app → booking → 🛡️ (shows **SOS** while on shift). Set a trusted contact to send them a live-location link.
  Reports can be anonymous. Admin → **Safety desk**.
- **Night shifts** (after 20:00): the business must promise transport; each worker agrees before booking.
- **Ratings** after a shift, both ways, hidden until both sides rate. **Offer full-time job** from the roster:
  the worker can say no; contact details unlock only after they say yes and the business pays the fee.

**5. Languages, offline and messages**
- Worker app in **हिंदी, ಕನ್ನಡ or English**. Tap **🔊** on key screens to hear them read aloud.
- Messages (reminders, pay, offers) are written to an outbox and sent by a background job, in the worker's language.
  They're mock-sent: see them in admin → **SMS outbox (dev)**. Worker app → **👤 Me → Messages** to opt in to WhatsApp or turn off reminders.
- Turn your network off: the app shows the last saved shifts with the time they were saved, and keeps check-ins to send later.

**6. Review as ops** (http://localhost:3001)
- **verifier@** approves businesses and new sites; **compliance@** handles shift review (gender requirements),
  minimum wage rates and policy changes, both of which need a second compliance officer; **safety@** can pause a site.
- A shift posted with words like "registration fee", "fair skin", "only girls" or "aadhaar copy" goes to **Shift review** instead of going live.
- Everyone sees **Analytics**: fill rate, no-show rate, time to fill, payout delay, dispute rate, fraud flags (with a table view).
- **finance@** sees held/failed payouts, approves manual payouts (a second finance login must approve), and runs **Reconciliation**.
- **disputes@** decides disputed timesheet minutes and other dispute cases (with attendance and chat evidence), and strike appeals.
- **safety@** runs the **Safety desk** (SOS, incidents) and can pause a site, which cancels its upcoming shifts with compensation.

Local login codes: each network can request 10 codes an hour (a real anti-abuse rule). If you hit it while testing,
wait an hour or run `npm run db:reset`.

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

Runs unit tests (money, minimum wage, phone, crypto, 2FA) and API tests against a separate test database
(`shiftkart_test`), including the 200-people-tap-at-once booking test. Abuse-case tests live in
`apps/api/test/abuse/`. [docs/ABUSE_CASES.md](docs/ABUSE_CASES.md) maps each case to its test.

End-to-end browser tests (business signup to live shift; worker signup in Hindi on a phone-sized screen; a full shift day; a trust journey across all three apps; Kannada; and the worker's privacy screen: download, consent, delete):

```bash
npm run test:e2e
```

They start the dev servers if they aren't running, and use the local database with fresh random test accounts.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Start API, admin console, business app and worker app |
| `npm run test:e2e` | Browser tests (Playwright) |
| `npm test` | Run all tests |
| `npm run typecheck` | Type-check every package |
| `npm run db:reset` | **Wipe** the local database and re-seed it |
| `npm run db:down` / `npm run db:up` | Stop / start the local database |
| `npm run totp -- <email>` | Current 2FA code for a local staff account |
| `npm run load-test -w @shiftkart/api` | Load test: 1000 workers race for one shift (wipes the **test** database only) |

## Project layout

```
apps/api        Backend API (Fastify, TypeScript)
apps/admin      Admin console (Next.js)
apps/business   Business web app (Next.js)
apps/worker     Worker app (Expo / React Native, Android-first; runs in a browser for testing)
e2e/            Playwright end-to-end tests
packages/db     SQL migrations, seed data, migration runner
packages/shared Money, phone, crypto and 2FA helpers shared by everything
infra/          Docker setup for Postgres (with PostGIS + pgvector for later phases)
docs/           Spec, abuse cases, decisions, legal checklist and review pack, security review,
                load test, breach plan, go-live checklist
```

## Troubleshooting

- **"Docker is not running"**: open Docker Desktop and wait until it says it's running.
- **Port already in use**: something else is on 4000, 3001, 3002, 8081 or 5433. Close it, or change `API_PORT` in `.env`.
- **Admin says "Could not reach the API"**: `npm run dev` isn't running, or the API crashed. Check the terminal.
- **2FA code rejected**: codes change every 30 s and each one works once. Run `npm run totp` again.
- **"Too many codes requested from this network"**: the local per-network OTP limit (10/hour). Wait, or `npm run db:reset`.
- **Worker app on a real Android phone or emulator**: needs Android Studio or the Expo Go app. Not set up yet. Ask before installing either.

## Real SMS / WhatsApp (not switched on)

Adapters for MSG91 (SMS) and Gupshup (WhatsApp) are in `apps/api/src/adapters/messaging.ts` but stay off.
They need a registered company, DLT-registered templates and a verified WhatsApp Business account, and they
refuse to run unless `ALLOW_REAL_MESSAGES=true` is set. Don't set it until you've decided to go live.

## Try Phase 6 (privacy and go-live readiness)

- **Your data (worker app):** 👤 Me → 🔒 *Privacy and my data*. From there you can:
  - download everything we hold about you as JSON;
  - switch off location checks, face checks or reminders (with face checks off, check-in is refused until you switch them back on);
  - see the grievance contact (a DRAFT placeholder until someone is appointed);
  - delete the account (type `DELETE`). Deletion is refused while you have an upcoming shift or unpaid pay.
- **Your data (business app):** *Privacy* in the top bar. Download your data or delete your account (owners must transfer or close the business first).
- **Load test:** `npm run load-test -w @shiftkart/api`. It prints latency and checks that exactly 50 of 1000 workers got the shift.
- **Emergency stop for payouts:** in the admin console, request the policy change `payouts.paused = true`. A second compliance officer approves it, and payouts then wait in the queue until it's switched off.
- **Before real users:**
  - [docs/GO_LIVE.md](docs/GO_LIVE.md): what's needed, plus the sandbox → live procedure;
  - [docs/LEGAL_REVIEW.md](docs/LEGAL_REVIEW.md): questions for a lawyer, in priority order;
  - [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md);
  - [docs/BREACH_RESPONSE.md](docs/BREACH_RESPONSE.md).

