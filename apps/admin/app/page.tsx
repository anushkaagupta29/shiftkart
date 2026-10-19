'use client';

import { useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { api } from './lib/api';

type Summary = { workers: number; businessUsers: number; businesses: number; businessesPendingVerification: number; suspendedUsers: number };

const QUEUES = [
  ['Business verification', 'Phase 2'], ['Flagged workers', 'Phase 4'], ['Flagged shifts', 'Phase 4'],
  ['Disputes', 'Phase 4'], ['Payouts (held / failed)', 'Phase 3'], ['SOS & incidents', 'Phase 4'],
];
const METRICS = ['Fill rate', 'No-show rate', 'Time to fill', 'Payout delay', 'Dispute rate', 'Fraud flags'];

function Dashboard() {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => { api<Summary>('/admin/summary').then(setS).catch(() => {}); }, []);
  const stats: [string, number | undefined][] = [
    ['Workers', s?.workers], ['Business users', s?.businessUsers], ['Businesses', s?.businesses],
    ['Awaiting verification', s?.businessesPendingVerification], ['Suspended users', s?.suspendedUsers],
  ];
  return (
    <>
      <h2>Dashboard</h2>
      <div className="grid" style={{ marginBottom: 20 }}>
        {stats.map(([l, n]) => <div className="stat" key={l}><div className="n">{n ?? '—'}</div><div className="l">{l}</div></div>)}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Queues</h3>
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
