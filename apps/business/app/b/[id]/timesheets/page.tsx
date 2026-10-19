'use client';

import { useParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText, ist, rupees } from '../../../lib/api';

type T = {
  id: string; firstName: string; shiftTitle: string; shiftStart: string; startedAt: string; endedAt: string; breakMinutes: number;
  payableMinutes: number; overtimeMinutes: number; grossPaise: number; basePayPaise: number; overtimePayPaise: number; allowancesPaise: number;
  flags: string[]; status: string; approvalDeadline: string; disputedMinutes: number | null; disputedPaise: number | null;
};
const hm = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;
const STATUS: Record<string, string> = {
  pending_approval: 'Waiting for you', approved: 'Approved', auto_approved: 'Auto-approved (no answer in time)', partially_disputed: 'Part disputed',
  disputed: 'Disputed', resolved: 'Dispute decided', awaiting_confirmation: 'Waiting for the worker to confirm hand-marked attendance',
};

function Timesheets() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<T[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [d, setD] = useState({ minutes: '', category: 'left_early', reason: '' });
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<T[]>(`/businesses/${id}/timesheets`).then(setRows).catch((e) => setErr(errText(e))); }, [id]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); setOpen(null); load(); } catch (e) { setErr(errText(e)); } };
  const pending = rows.filter((r) => r.status === 'pending_approval');

  return (
    <>
      <h2>Timesheets</h2>
      <p className="muted">Approve hours within 12 hours of check-out, or they are approved automatically. If something is wrong, dispute only the minutes in question: the rest is paid on time.</p>
      {pending.length > 1 && <p><button onClick={() => act(async () => { for (const r of pending) await api(`/businesses/${id}/timesheets/${r.id}/approve`, { method: 'POST' }); })}>Approve all {pending.length}</button></p>}
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <table>
          <thead><tr><th>Worker / shift</th><th>Worked</th><th>Pay</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((t) => (
            <Fragment key={t.id}>
              <tr>
                <td><b>{t.firstName}</b><div className="muted">{t.shiftTitle} · {ist(t.shiftStart, { dateStyle: 'medium' })}</div></td>
                <td>{ist(t.startedAt, { timeStyle: 'short' })}–{ist(t.endedAt, { timeStyle: 'short' })}<div className="muted">{hm(t.payableMinutes)} paid{t.breakMinutes ? `, ${t.breakMinutes}m break` : ''}{t.overtimeMinutes ? `, +${hm(t.overtimeMinutes)} overtime` : ''}</div>
                  {t.flags.length > 0 && <div className="err">⚠ {t.flags.join(', ').replaceAll('_', ' ')}</div>}</td>
                <td className="cost">{rupees(t.grossPaise)}<div className="muted">{t.disputedPaise ? `${rupees(t.disputedPaise)} held` : ''}</div></td>
                <td>{STATUS[t.status] ?? t.status}{t.status === 'pending_approval' && <div className="muted">auto-approves {ist(t.approvalDeadline, { timeStyle: 'short' })}</div>}</td>
                <td className="row">{t.status === 'pending_approval' && (<>
                  <button onClick={() => act(() => api(`/businesses/${id}/timesheets/${t.id}/approve`, { method: 'POST' }))}>Approve</button>
                  <button className="secondary" onClick={() => setOpen(open === t.id ? null : t.id)}>Dispute…</button>
                </>)}</td>
              </tr>
              {open === t.id && (
                <tr><td colSpan={5}>
                  <div className="row">
                    <input type="number" min={1} max={t.payableMinutes + t.overtimeMinutes} placeholder="Minutes" value={d.minutes} onChange={(e) => setD({ ...d, minutes: e.target.value })} style={{ width: 100 }} />
                    <select value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })}>
                      <option value="arrived_late">Arrived late</option><option value="left_early">Left early</option><option value="long_breaks">Long breaks</option>
                      <option value="not_working">Not working</option><option value="did_not_attend">Did not attend</option><option value="other">Other</option>
                    </select>
                    <input style={{ flex: 1 }} placeholder="What happened? (shown to the worker and our team)" value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} />
                    <button className="danger" onClick={() => act(() => api(`/businesses/${id}/timesheets/${t.id}/dispute`, { method: 'POST', body: { minutes: Number(d.minutes), category: d.category, reason: d.reason } }))}>Dispute these minutes</button>
                  </div>
                </td></tr>
              )}
            </Fragment>
          ))}</tbody>
        </table>
        {rows.length === 0 && <p className="muted">No timesheets yet. They appear when workers check out.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Timesheets /></Shell>; }
