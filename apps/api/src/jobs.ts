import type { Db } from './db';
import type { SmsSender } from './adapters/sms';
import type { PayoutProvider } from './adapters/payouts';
import { sweepExpiredOffers } from './booking';
import { autoApproveDue, processPayouts, reconcile, settleShifts } from './money';
import { istDate } from './time';
import { revealDueRatings } from './community';
import { disputeSlaCheck } from './cases';

export type JobDeps = { db: Db; sms: SmsSender; payouts: PayoutProvider; dataKey: string };

/**
 * One pass of all background work. Every job is safe to run twice at once: work is claimed with
 * row locks (SKIP LOCKED) and money movements are idempotent.
 */
export async function runJobsOnce(d: JobDeps) {
  return {
    offersExpired: await sweepExpiredOffers(d.db, d.sms, d.dataKey),
    autoApproved: await autoApproveDue(d.db),
    payoutsPaid: await processPayouts(d.db, d.payouts, d.dataKey, d.sms),
    shiftsSettled: await settleShifts(d.db, d.payouts),
    ratingsRevealed: await revealDueRatings(d.db),
    disputesOverdue: await disputeSlaCheck(d.db),
  };
}

/** In-process scheduler (state lives in Postgres, so a restart loses nothing). Daily reconciliation after 02:00 IST. */
export function startJobs(d: JobDeps, log: { error: (o: object, m: string) => void }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJobsOnce(d);
      const now = new Date();
      const istHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now));
      const yesterday = istDate(new Date(now.getTime() - 86400_000));
      if (istHour >= 2) {
        const done = await d.db.query('SELECT 1 FROM reconciliation_runs WHERE run_date = $1 AND run_by IS NULL', [yesterday]);
        if (!done.rowCount) await reconcile(d.db, yesterday);
      }
    } catch (err) {
      log.error({ err }, 'background jobs failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
