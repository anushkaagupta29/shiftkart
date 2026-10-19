'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, useStaff } from '../components/Shell';
import { api, ApiError, fmtIST } from '../lib/api';

type D = {
  id: string; worker: string; business: string; shift: string; payableMinutes: number; disputedMinutes: number; disputedPaise: number; category: string; reason: string; at: string;
  proposal: { minutes: number; reason: string; by: string } | null; flags: string[];
  evidence: { type: string; mode: string; status: string; effective_at: string; distance_m: number | null; face_score: number | null; flags: string[] }[];
};

function Resolve({ d, onDone }: { d: D; onDone: () => void }) {
  const staff = useStaff();
  const [minutes, setMinutes] = useState(String(d.disputedMinutes));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async (path: string, body?: object) => {
    setErr('');
    try { await api(`/admin/timesheets/${d.id}/${path}`, { method: 'POST', body }); onDone(); } catch (e) { setErr(e instanceof ApiError ? (e.issues?.[0]?.message ?? e.message) : 'Failed'); }
  };
  if (d.proposal) {
    return (
      <div>
        <p className="note">Proposed by {d.proposal.by}: pay the worker for {d.proposal.minutes} of {d.disputedMinutes} disputed minutes. “{d.proposal.reason}”</p>
        {d.proposal.by === staff.email ? <p className="muted">Waiting for a second disputes officer.</p> : <button onClick={() => go('confirm-resolution')}>Confirm as second approver</button>}
        {err && <p className="err">{err}</p>}
      </div>
    );
  }
  return (
    <div>
      <div className="row">
        <label>Pay worker for <input type="number" min={0} max={d.disputedMinutes} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} /> of {d.disputedMinutes} minutes</label>
        <input style={{ flex: 1 }} placeholder="Decision and reason (shown to both sides)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button onClick={() => go('resolve', { awardMinutes: Number(minutes), reason })}>Decide</button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function Disputes() {
  const [rows, setRows] = useState<D[]>([]);
  const load = useCallback(() => { api<D[]>('/admin/timesheets/disputed').then(setRows); }, []);
  useEffect(load, [load]);
  return (
    <>
      <h2>Timesheet disputes</h2>
      <p className="muted">Only the disputed minutes are held; the rest was already paid. Large amounts need a second officer. Full dispute workflow (chat, photos, deadlines) arrives in Phase 4.</p>
      {rows.length === 0 && <div className="panel muted">No open disputes.</div>}
      {rows.map((d) => (
        <div className="panel" key={d.id}>
          <h3 style={{ marginTop: 0 }}>{d.worker} · {d.shift} <span className="muted">({d.business})</span></h3>
          <p><b>{d.disputedMinutes} of {d.payableMinutes} min</b> disputed ({d.category.replaceAll('_', ' ')}), ₹{(d.disputedPaise / 100).toFixed(2)} held. “{d.reason}” · {fmtIST(d.at)}</p>
          {d.flags.length > 0 && <p className="err">Timesheet flags: {d.flags.join(', ')}</p>}
          <table><thead><tr><th>Attendance</th><th>When</th><th>How</th><th>Distance</th><th>Face match</th><th>Flags</th></tr></thead>
            <tbody>{d.evidence.map((e, i) => (
              <tr key={i}><td>{e.type.replace('_', ' ')}{e.status === 'rejected' ? ' (refused)' : ''}</td><td>{fmtIST(e.effective_at)}</td><td>{e.mode.replace('_', ' ')}</td>
                <td>{e.distance_m != null ? `${e.distance_m} m` : '—'}</td><td>{e.face_score ?? '—'}</td><td>{e.flags.join(', ')}</td></tr>
            ))}</tbody></table>
          <div style={{ marginTop: 10 }}><Resolve d={d} onDone={load} /></div>
        </div>
      ))}
    </>
  );
}

export default function Page() { return <Shell><Disputes /></Shell>; }
