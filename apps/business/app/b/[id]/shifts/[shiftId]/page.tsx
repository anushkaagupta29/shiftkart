'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../../components/Shell';
import { api, errText, ist, rupees } from '../../../../lib/api';

type Detail = {
  id: string; title: string; siteName: string; startsAt: string; endsAt: string; headcount: number; filled: number; status: string;
  payType: string; payPaise: number; totalPaise: number; reviewReasons: string[]; waitlisted: number;
  cost: { workerPayTotalPaise: number; allowancesTotalPaise: number; feePaise: number; gstOnFeePaise: number; totalPaise: number };
  roster: { bookingId: string; firstName: string; status: string; bookedAt: string; source: string }[];
  payments: { id: string; status: string; amountPaise: number; createdAt: string }[];
};

function ShiftDetail() {
  const { id, shiftId } = useParams<{ id: string; shiftId: string }>();
  const router = useRouter();
  const [s, setS] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<Detail>(`/businesses/${id}/shifts/${shiftId}`).then(setS).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [id, shiftId]);

  const fund = async () => {
    setErr('');
    try {
      // One key per click-session: a double click or a retry can't create two payments.
      const key = sessionStorage.getItem(`fund:${shiftId}`) ?? crypto.randomUUID();
      sessionStorage.setItem(`fund:${shiftId}`, key);
      const r = await api(`/businesses/${id}/shifts/${shiftId}/fund`, { method: 'POST', headers: { 'idempotency-key': key } });
      router.push(`/pay/${r.intentId}?b=${id}&s=${shiftId}`);
    } catch (e) { setErr(errText(e)); }
  };
  const cancel = async () => {
    const reason = prompt('Why are you withdrawing this shift?');
    if (!reason) return;
    try { await api(`/businesses/${id}/shifts/${shiftId}/cancel`, { method: 'POST', body: { reason } }); load(); } catch (e) { setErr(errText(e)); }
  };
  if (!s) return <p className="muted">{err || 'Loading…'}</p>;
  return (
    <>
      <h2>{s.title}</h2>
      <div className="panel">
        <p><b>{ist(s.startsAt)} – {ist(s.endsAt, { timeStyle: 'short' })}</b> at {s.siteName}</p>
        <p>Status: <span className={`pill ${s.status === 'live' ? 'status-live' : ''}`}>{s.status.replace('_', ' ')}</span> · Filled {s.filled}/{s.headcount}{s.waitlisted ? ` · ${s.waitlisted} on waitlist` : ''}</p>
        {s.status === 'pending_review' && <p className="note">Our team is reviewing this post ({s.reviewReasons.join(', ').replaceAll('_', ' ')}).</p>}
        {s.status === 'pending_funding' && <p>Fund this shift to publish it. Workers only see funded shifts, so they know they will be paid.</p>}
        <table className="cost" style={{ maxWidth: 420 }}><tbody>
          <tr><td>Worker pay</td><td>{rupees(s.cost.workerPayTotalPaise)}</td></tr>
          <tr><td>Allowances</td><td>{rupees(s.cost.allowancesTotalPaise)}</td></tr>
          <tr><td>Fee</td><td>{rupees(s.cost.feePaise)}</td></tr>
          <tr><td>GST on fee</td><td>{rupees(s.cost.gstOnFeePaise)}</td></tr>
          <tr className="total"><td>Total</td><td>{rupees(s.cost.totalPaise)}</td></tr>
        </tbody></table>
        <p className="row">
          {s.status === 'pending_funding' && <button onClick={fund}>Fund {rupees(s.totalPaise)}</button>}
          {['pending_funding', 'pending_review'].includes(s.status) && <button className="secondary" onClick={cancel}>Withdraw</button>}
        </p>
        {err && <p className="err">{err}</p>}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Workers</h3>
        <table><thead><tr><th>Name</th><th>Status</th><th>Booked</th></tr></thead>
          <tbody>{s.roster.map((r) => <tr key={r.bookingId}><td>{r.firstName}</td><td>{r.status}</td><td>{ist(r.bookedAt)}{r.source === 'waitlist' ? ' (from waitlist)' : ''}</td></tr>)}</tbody></table>
        {s.roster.length === 0 && <p className="muted">Nobody yet.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><ShiftDetail /></Shell>; }
