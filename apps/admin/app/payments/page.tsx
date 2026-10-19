'use client';

import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, fmtIST } from '../lib/api';

type P = { id: string; business: string; shiftId: string; amountPaise: number; status: string; orderRef: string; createdAt: string; capturedAt: string | null };

function Payments() {
  const [rows, setRows] = useState<P[]>([]);
  useEffect(() => { api<{ items: P[] }>('/admin/payments?pageSize=100').then((r) => setRows(r.items)); }, []);
  return (
    <>
      <h2>Shift funding (mock escrow)</h2>
      <div className="panel">
        <table><thead><tr><th>Business</th><th>Amount</th><th>Order</th><th>Created</th><th>Captured</th><th>Status</th></tr></thead>
          <tbody>{rows.map((p) => <tr key={p.id}><td>{p.business}</td><td>₹{(p.amountPaise / 100).toFixed(2)}</td><td className="mono">{p.orderRef}</td><td>{fmtIST(p.createdAt)}</td><td>{fmtIST(p.capturedAt)}</td><td><span className="pill">{p.status}</span></td></tr>)}</tbody>
        </table>
        {rows.length === 0 && <p className="muted">No payments yet.</p>}
      </div>
    </>
  );
}

export default function Page() { return <Shell><Payments /></Shell>; }
