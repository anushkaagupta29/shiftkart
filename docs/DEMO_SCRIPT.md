# Demo video script (about 2 minutes)

A screen recording for a README, LinkedIn post or job application. Record at 1080p with the three
apps side by side: business app (left), worker app in phone view (middle), admin console (right).
Speak plainly; the times are a guide.

## Before you record

```bash
npm run db:reset
```

```bash
npm run dev
```

- Log in to the business app as **9000000101** and the admin console as **safety@**. Run `npm run totp -- safety@shiftkart.local` for the 2FA code.
- Sign up a fresh worker in **हिंदी** and finish identity, selfie, UPI and profile. Do this before recording; onboarding is shown in a single cut below.
- Have a terminal ready for the "time machine" curl in the README and for the load test.
- Close notifications and hide browser bookmarks.

## Script

**0:00–0:12. The problem**
> "Shift workers in India find day work through WhatsApp groups and middlemen: fees to get a job, late or missing pay, no record. ShiftKart is a staffing platform where the business pays upfront and the worker never pays anything."

Show: the worker app home screen in Hindi, with the "ShiftKart never asks for money" banner.

**0:12–0:30. Business posts a shift**
> "A warehouse posts a shift. The cost updates live, including GST and the gig-worker welfare fee, which the business pays, not the worker. Pay below minimum wage is blocked."

Show:
1. In the business app, choose **Post a shift**.
2. Type ₹60/hour to show the minimum-wage block, then ₹120/hour.
3. **Create**, then **Fund**, then **Pay (simulate success)**. The shift goes live.

**0:30–0:45. Worker accepts, in Hindi**
> "The money is in escrow before any worker sees the shift. The worker sees full pay, time and place, in their language, and can listen to it."

Show:
1. The shift appears in the worker app.
2. Tap 🔊.
3. Tap **Accept**.
4. The worker's first name appears on the business roster.

**0:45–1:05. Check-in that can't be faked**
> "At the gate, the supervisor's screen shows a code that changes every 30 seconds and works offline. The worker must be inside the geofence, enter the current code and pass a selfie match. An old code or fake GPS gets flagged."

Show:
1. Run the time-machine curl so the shift starts now.
2. Open the gate screen.
3. In the worker app, tap **I am at the site**, then try an old code: it is rejected.
4. Enter the current code: checked in.

**1:05–1:25. Paid the same day**
> "After checkout the business approves the timesheet, or disputes only the minutes it questions. A double-entry ledger moves the money from escrow to the worker, and every payout is idempotent, so a retry can never pay twice."

Show:
1. Check out, then **Approve** in Timesheets.
2. Run the jobs.
3. Open the payslip in the worker's **Earnings** tab.
4. Open the GST invoice in the business app.

**1:25–1:45. Trust, safety, and the law**
> "Chat blocks payment requests and links. Late cancellations earn strikes, which workers can appeal. Under Karnataka's new gig workers law, removing a worker needs 14 days' written notice: ops issue the notice, the worker reads the reasons and replies in the app."

Show:
1. Type "send 500 rs fee on gpay" in chat: blocked.
2. In the admin console, choose **Give removal notice**.
3. Show the notice card in the worker's 👤 Me screen.

**1:45–2:00. Under load**
> "And the hard part: a thousand people tap Accept on fifty slots at the same moment. Exactly fifty get it, no double-bookings, no errors, and the ledger still balances. Around a thousand requests a second on a laptop, with 294 automated tests. Link in the description."

Show: the terminal running `npm run load-test -w @shiftkart/api`, ending on the line "correctness: filled_count 50, confirmed bookings 50, expected 50".

## After recording

- Upload as unlisted on YouTube or Loom, and put the link at the top of the README.
- Add captions; many reviewers watch muted.
- Keep a 30-second cut (0:30–1:25) for LinkedIn.
