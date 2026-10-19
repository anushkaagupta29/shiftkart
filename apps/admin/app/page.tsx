'use client';

import { useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { api } from './lib/api';

type Summary = { workers: number; verifiedWorkers: number; businessUsers: number; businesses: number; businessesPendingVerification: number; suspendedUsers: number; shiftsPendingReview: number; liveShifts: number; openFraudFlags: number; sitesPendingReview: number; payoutsOverdue: number; payoutsHeld: number; disputesOpen: number; reconciliationMismatches: number };

const QUEUES = [['Full dispute workflow', 'Phase 4'], ['SOS & incidents', 'Phase 4'], ['Strike appeals', 'Phase 4']];
const METRICS = ['Fill rate', 'No-show rate', 'Time to fill', 'Payout delay', 'Dispute rate', 'Fraud flags'];

function Dashboard() {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => { api<Summary>('/admin/summary').then(setS).catch(() => {}); }, []);
  const stats: [string, number | undefined, string?][] = [
    ['Businesses awaiting verification', s?.businessesPendingVerification, '/businesses'], ['New sites to check', s?.sitesPendingReview, '/businesses?status=verified'],
    ['Shifts in review', s?.shiftsPendingReview, '/shift-review'], ['Open fraud flags', s?.openFraudFlags, '/flags'],
    ['Payouts over 24 h', s?.payoutsOverdue, '/payouts'], ['Payouts held / failed', s?.payoutsHeld, '/payouts'],
    ['Timesheet disputes', s?.disputesOpen, '/disputes'], ['Reconciliation mismatches (7 days)', s?.reconciliationMismatches, '/reconciliation'],
    ['Live upcoming shifts', s?.liveShifts], ['Verified workers', s?.verifiedWorkers], ['All workers', s?.workers],
    ['Businesses', s?.businesses], ['Suspended users', s?.suspendedUsers],
  ];
  return (
    <>
      <h2>Dashboard</h2>
      <div className="grid" style={{ marginBottom: 20 }}>
        {stats.map(([l, n, href]) => (
          <a className="stat" key={l} href={href} style={{ textDecoration: 'none', color: 'inherit', cursor: href ? 'pointer' : 'default' }}>
            <div className="n">{n ?? '—'}</div><div className="l">{l}</div>
          </a>
        ))}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Coming next</h3>
        <table><tbody>
          {QUEUES.map(([q, p]) => <tr key={q}><td>{q}</td><td className="muted">Arrives in {p}</td></tr>)}
        </tbody></table>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Metrics</h3>
        <p className="muted">{METRICS.join(' · ')}: dashboards arrive in Phase 5, once shifts and payouts exist.</p>
      </div>
    </>
  );
}

export default function Page() {
  return <Shell><Dashboard /></Shell>;
}
