'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, fmtIST } from '../lib/api';

type R = { id: string; date: string; providerNetPaise: number; ledgerNetPaise: number; diffPaise: number; status: string; runBy: string; at: string };
const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;

function Recon() {
  const [rows, setRows] = useState<R[]>([]);
  const [date, setDate] = useState(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  const load = useCallback(() => { api<R[]>('/admin/reconciliation').then(setRows); }, []);
  useEffect(load, [load]);
  return (
    <>
      <h2>Daily reconciliation</h2>
      <p className="muted">Compares the payment provider&apos;s record of money in and out with our ledger, per IST day. Runs automatically after 02:00 for the previous day. Any difference raises a flag.</p>
      <div className="panel row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={async () => { await api('/admin/reconciliation/run', { method: 'POST', body: { date } }); load(); }}>Run now</button>
      </div>
      <div className="panel">
        <table><thead><tr><th>Day</th><th>Provider net</th><th>Our ledger net</th><th>Difference</th><th>Result</th><th>Run</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td>{r.date}</td><td>{rs(r.providerNetPaise)}</td><td>{rs(r.ledgerNetPaise)}</td>
              <td className={r.diffPaise ? 'err' : ''}>{rs(r.diffPaise)}</td><td>{r.status === 'matched' ? <span className="ok">matched</span> : <span className="err">MISMATCH</span>}</td>
              <td>{fmtIST(r.at)} · {r.runBy}</td></tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">No runs yet.</p>}
      </div>
    </>
  );
}

export default function Page() { return <Shell><Recon /></Shell>; }
