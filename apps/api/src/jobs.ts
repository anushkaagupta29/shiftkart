import type { Db } from './db';
import type { SmsSender } from './adapters/sms';
import { sweepExpiredOffers } from './booking';

/** Background work in the API process. Phase 3 moves this to a durable queue alongside payouts. */
export function startJobs(db: Db, sms: SmsSender, dataKey: string, log: { error: (o: object, m: string) => void }) {
  const timer = setInterval(() => {
    sweepExpiredOffers(db, sms, dataKey).catch((err) => log.error({ err }, 'waitlist sweep failed'));
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
