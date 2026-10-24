'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../../components/Shell';
import { api, errText, ist, rupees } from '../../../../lib/api';

type Detail = {
  id: string; title: string; siteName: string; startsAt: string; endsAt: string; headcount: number; filled: number; status: string;
  payType: string; payPaise: number; totalPaise: number; reviewReasons: string[]; waitlisted: number;
  cost: { workerPayTotalPaise: number; allowancesTotalPaise: number; feePaise: number; gstOnFeePaise: number; welfareCentralPaise?: number; welfareStatePaise?: number; totalPaise: number };
  roster: { bookingId: string; firstName: string; status: string; bookedAt: string; source: string }[];
  payments: { id: string; status: string; amountPaise: number; createdAt: string }[];
};

function ShiftDetail() {
  const { id, shiftId } = useParams<{ id: string; shiftId: string }>();
  const router = useRouter();
  const [s, setS] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [money, setMoney] = useState<{ fundedPaise: number; releasedPaise: number; refundedPaise: number; heldPaise: number; settledAt: string | null } | null>(null);
  const load = () => {
    api<Detail>(`/businesses/${id}/shifts/${shiftId}`).then((d) => {
      setS(d);
      if (['live', 'completed'].includes(d.status)) api(`/businesses/${id}/shifts/${shiftId}/money`).then(setMoney).catch(() => {});
    }).catch((e) => setErr(errText(e)));
  };
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
    let warning = 'Withdraw this shift? Nothing has been charged.';
    if (s?.status === 'live') {
      const p = await api(`/businesses/${id}/shifts/${shiftId}/cancel-preview`);
      warning = `Cancel this live shift? It starts in ${p.hoursBefore} hours. ${p.bookedWorkers} booked worker(s) will each get ${p.compensationPercent}% of their shift pay (₹${(p.perWorkerPayPaise * p.compensationPercent / 10000).toFixed(2)}) from your funded amount${p.checkedIn ? `, and ${p.checkedIn} already at the site get the turn-away amount` : ''}. The rest is refunded.`;
    }
    const reason = prompt(`${warning}\n\nReason (shown to workers):`);
    if (!reason) return;
    try { const r = await api(`/businesses/${id}/shifts/${shiftId}/cancel`, { method: 'POST', body: { reason } }); if (r.compensationPaise) alert(`Cancelled. ${rupees(r.compensationPaise)} paid to workers as compensation; the rest is refunded.`); load(); } catch (e) { setErr(errText(e)); }
  };
  const rowAct = async (fn: () => Promise<unknown>, done?: string) => { setErr(''); try { await fn(); if (done) alert(done); load(); } catch (e) { setErr(errText(e)); } };
  const rateWorker = (bookingId: string, name: string) => {
    const stars = prompt(`Rate ${name} from 1 to 5. They won't see it until they rate you too.`);
    if (stars) rowAct(() => api(`/businesses/${id}/bookings/${bookingId}/rating`, { method: 'POST', body: { stars: Number(stars) } }), 'Thanks for rating.');
  };
  const hire = (bookingId: string, name: string) => {
    const roleTitle = prompt(`Offer ${name} a full-time job. Role title:`);
    if (roleTitle) rowAct(() => api(`/businesses/${id}/hire-requests`, { method: 'POST', body: { bookingId, roleTitle } }), `Offer sent. ${name} can accept or decline in the app. See Hires.`);
  };
  const turnAwayW = (bookingId: string, name: string) => {
    const reason = prompt(`Send ${name} home (site not ready)? They get the turn-away payment for turning up. Reason:`);
    if (reason) rowAct(() => api(`/businesses/${id}/bookings/${bookingId}/turn-away`, { method: 'POST', body: { reason } }));
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
          {(s.cost.welfareCentralPaise ?? 0) + (s.cost.welfareStatePaise ?? 0) > 0 && <tr><td>Gig-worker welfare contribution</td><td>{rupees((s.cost.welfareCentralPaise ?? 0) + (s.cost.welfareStatePaise ?? 0))}</td></tr>}
          <tr className="total"><td>Total</td><td>{rupees(s.cost.totalPaise)}</td></tr>
        </tbody></table>
        <p className="row">
          {s.status === 'live' && <a href={`/b/${id}/shifts/${shiftId}/gate`}><button>Open gate screen (check-in code)</button></a>}
          {s.status === 'pending_funding' && <button onClick={fund}>Fund {rupees(s.totalPaise)}</button>}
          {['pending_funding', 'pending_review'].includes(s.status) && <button className="secondary" onClick={cancel}>Withdraw</button>}
          {s.status === 'live' && <button className="danger" onClick={cancel}>Cancel shift…</button>}
        </p>
        {err && <p className="err">{err}</p>}
      </div>
      {money && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Money</h3>
          <table className="cost" style={{ maxWidth: 420 }}><tbody>
            <tr><td>You funded</td><td>{rupees(money.fundedPaise)}</td></tr>
            <tr><td>Paid out (wages, fee, GST)</td><td>{rupees(money.releasedPaise)}</td></tr>
            <tr><td>Refunded to you</td><td>{rupees(money.refundedPaise)}</td></tr>
            <tr className="total"><td>Still held</td><td>{rupees(money.heldPaise)}</td></tr>
          </tbody></table>
          {money.settledAt ? <p className="muted">Closed {ist(money.settledAt)}. See Invoices for the GST invoice.</p> : <p className="muted">Unused money is refunded when the shift closes.</p>}
        </div>
      )}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Workers</h3>
        <table><thead><tr><th>Name</th><th>Status</th><th>Booked</th><th /></tr></thead>
          <tbody>{s.roster.map((r) => (
            <tr key={r.bookingId}><td>{r.firstName}</td><td>{r.status.replace('_', ' ')}</td><td>{ist(r.bookedAt)}{r.source === 'waitlist' ? ' (from waitlist)' : ''}</td>
              <td className="row">
                {['confirmed', 'checked_in', 'completed', 'turned_away'].includes(r.status) && <a href={`/b/${id}/chat/${r.bookingId}`}><button className="secondary">Chat</button></a>}
                {r.status === 'checked_in' && <button className="secondary" onClick={() => turnAwayW(r.bookingId, r.firstName)}>Send home (paid)</button>}
                {['completed', 'turned_away'].includes(r.status) && <button className="secondary" onClick={() => rateWorker(r.bookingId, r.firstName)}>Rate</button>}
                {r.status === 'completed' && <button className="secondary" onClick={() => hire(r.bookingId, r.firstName)}>Offer full-time job</button>}
                <a href={`/b/${id}/report?booking=${r.bookingId}`}><button className="secondary">Report</button></a>
              </td></tr>
          ))}</tbody></table>
        {s.roster.length === 0 && <p className="muted">Nobody yet.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><ShiftDetail /></Shell>; }
