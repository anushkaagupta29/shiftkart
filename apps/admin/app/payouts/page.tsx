'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, hasRole, useStaff } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, ApiError, fmtIST } from '../lib/api';

type Row = { id: string; workerId: string; firstName: string; kind: string; amountPaise: number; status: string; heldReason: string | null; attempts: number; lastError: string | null; paidTo?: string; requestedBy: string | null; approvedBy: string | null; reason: string | null; approvedAt: string; paidAt: string | null; overdue: boolean };
const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;
const STATUSES = ['held', 'pending_approval', 'queued', 'processing', 'paid', 'failed', 'reversed', ''];

function Payouts() {
  const staff = useStaff();
  const [status, setStatus] = useState('held');
  const [rows, setRows] = useState<Row[]>([]);
  const [m, setM] = useState({ workerId: '', amount: '', reason: '' });
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<{ items: Row[] }>(`/admin/payouts?pageSize=100${status ? `&status=${status}` : ''}`).then((r) => setRows(r.items)); }, [status]);
  useEffect(load, [load]);
  const isFinance = hasRole(staff, ['finance']);
  const manual = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('/admin/payouts/manual', { method: 'POST', body: { workerId: m.workerId, amountPaise: Math.round(Number(m.amount) * 100), reason: m.reason } }); setStatus('pending_approval'); load(); }
    catch (e2) { setErr(e2 instanceof ApiError ? (e2.issues?.[0]?.message ?? e2.message) : 'Failed'); }
  };
  return (
    <>
      <h2>Payouts</h2>
      <p className="muted">Workers are paid automatically within minutes of approval. This page is for the exceptions: held, failed and manual payouts.</p>
      <div className="panel row">{STATUSES.map((s) => <button key={s} className={status === s ? '' : 'secondary'} onClick={() => setStatus(s)}>{s ? s.replace('_', ' ') : 'all'}</button>)}</div>
      <div className="panel">
        <table><thead><tr><th>Worker</th><th>Amount</th><th>Kind</th><th>Status</th><th>Approved</th><th>Paid</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td>{p.firstName}<div className="mono muted">{p.workerId.slice(0, 8)}</div>{p.paidTo && <div className="muted">{p.paidTo}</div>}</td>
              <td>{rs(p.amountPaise)}</td><td>{p.kind}{p.reason && <div className="muted">{p.reason}</div>}</td>
              <td><span className="pill">{p.status}</span>{p.heldReason && <div className="err">{p.heldReason.replaceAll('_', ' ')}</div>}{p.overdue && <div className="err">over 24 h</div>}
                {p.attempts > 1 && <div className="muted">{p.attempts} tries{p.lastError ? `: ${p.lastError}` : ''}</div>}</td>
              <td>{fmtIST(p.approvedAt)}{p.requestedBy && <div className="muted">asked by {p.requestedBy}</div>}</td>
              <td>{fmtIST(p.paidAt)}</td>
              <td>
                {isFinance && ['held', 'failed'].includes(p.status) && <Decide options={[['retry', 'Retry now']]} onDecide={async (_d, reason) => { await api(`/admin/payouts/${p.id}/retry`, { method: 'POST', body: { reason } }); load(); }} />}
                {isFinance && p.status === 'pending_approval' && <Decide onDecide={async (decision, reason) => { await api(`/admin/payouts/${p.id}/decide`, { method: 'POST', body: { decision, reason } }); load(); }} />}
              </td>
            </tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">Nothing here.</p>}
      </div>
      {isFinance && (
        <form className="panel" onSubmit={manual}>
          <h3 style={{ marginTop: 0 }}>Manual payout</h3>
          <p className="muted">Only to a worker&apos;s own verified account. A second finance officer must approve it. Daily limit applies.</p>
          <div className="row">
            <input placeholder="Worker id" value={m.workerId} onChange={(e) => setM({ ...m, workerId: e.target.value })} required style={{ minWidth: 300 }} />
            <input placeholder="Amount ₹" value={m.amount} onChange={(e) => setM({ ...m, amount: e.target.value })} required />
            <input style={{ flex: 1 }} placeholder="Reason" value={m.reason} onChange={(e) => setM({ ...m, reason: e.target.value })} required />
            <button>Request</button>
          </div>
          {err && <p className="err">{err}</p>}
        </form>
      )}
    </>
  );
}

export default function Page() { return <Shell><Payouts /></Shell>; }
