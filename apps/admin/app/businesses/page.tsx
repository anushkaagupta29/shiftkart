'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, hasRole, useStaff } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, fmtIST } from '../lib/api';

type Row = { id: string; legalName: string; tradeName: string | null; status: string; riskTier: string; riskReasons: string[]; submittedAt: string | null; approvals: number; approvalsNeeded: number };
type Detail = Row & {
  gstin: string | null; gstLegalName: string | null; panLast4: string | null; udyamOrSeNo: string | null; signatoryName: string | null; round: number; members: number;
  sites: { id: string; name: string; address: string; cityCode: string; geofenceM: number; status: string; statusReason: string | null; lat: number; lng: number }[];
  reviews: { staff: string; round: number; decision: string; reason: string; at: string }[];
  flags: { id: string; rule: string; status: string; at: string }[];
};

function BizDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const staff = useStaff();
  const [d, setD] = useState<Detail | null>(null);
  const load = useCallback(() => { api<Detail>(`/admin/businesses/${id}`).then(setD); }, [id]);
  useEffect(load, [load]);
  if (!d) return <div className="panel">Loading…</div>;
  const canReview = hasRole(staff, ['ops_verifier']);
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{d.legalName} <span className="pill">{d.status}</span> <span className="pill">risk: {d.riskTier}</span></h3>
      {d.riskReasons.length > 0 && <div className="note">Checks to resolve: {d.riskReasons.join(', ').replaceAll('_', ' ')}. High-risk businesses need two different verifiers.</div>}
      <table><tbody>
        <tr><th>GSTIN</th><td className="mono">{d.gstin ?? '—'}</td></tr>
        <tr><th>Name on GST</th><td>{d.gstLegalName ?? 'not found in GSTN'}</td></tr>
        <tr><th>PAN</th><td className="mono">{d.panLast4 ? `******${d.panLast4}` : '—'}</td></tr>
        <tr><th>Udyam / S&amp;E</th><td>{d.udyamOrSeNo ?? '—'}</td></tr>
        <tr><th>Signatory</th><td>{d.signatoryName ?? '—'}</td></tr>
        <tr><th>Team members</th><td>{d.members}</td></tr>
      </tbody></table>
      <h4>Sites</h4>
      <table><tbody>{d.sites.map((s) => (
        <tr key={s.id}><td>{s.name}<div className="muted">{s.address}</div></td><td>{s.cityCode} · {s.geofenceM} m{s.statusReason && <div className="muted">{s.statusReason}</div>}</td>
          <td><a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${s.lat}/${s.lng}`}>map</a></td><td><span className="pill">{s.status}</span></td>
          <td>{s.status === 'pending_verify' && d.status === 'verified' && canReview && <Decide onDecide={async (dec, reason) => { await api(`/admin/sites/${s.id}/review`, { method: 'POST', body: { decision: dec, reason } }); load(); onChanged(); }} />}</td></tr>
      ))}</tbody></table>
      {d.reviews.length > 0 && <><h4>Reviews</h4><ul>{d.reviews.map((r, i) => <li key={i}>Round {r.round}: <b>{r.decision}</b> by {r.staff} ({fmtIST(r.at)}): {r.reason}</li>)}</ul></>}
      {d.flags.length > 0 && <><h4>Fraud flags</h4><ul>{d.flags.map((f) => <li key={f.id}>{f.rule} ({f.status})</li>)}</ul></>}
      {d.status === 'pending' && canReview && (
        <><h4>Decision ({d.approvals}/{d.approvalsNeeded} approvals)</h4>
          <Decide onDecide={async (dec, reason) => { await api(`/admin/businesses/${id}/review`, { method: 'POST', body: { decision: dec, reason } }); load(); onChanged(); }} /></>
      )}
    </div>
  );
}

function Businesses() {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<Row[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const load = useCallback(() => { api<{ items: Row[] }>(`/admin/businesses?pageSize=100${status ? `&status=${status}` : ''}`).then((r) => setRows(r.items)); }, [status]);
  useEffect(load, [load]);
  return (
    <>
      <h2>Business verification</h2>
      <div className="panel row">
        {['pending', 'verified', 'rejected', 'draft', ''].map((s) => <button key={s} className={status === s ? '' : 'secondary'} onClick={() => setStatus(s)}>{s || 'all'}</button>)}
      </div>
      {sel && <BizDetail id={sel} onChanged={load} />}
      <div className="panel">
        <table><thead><tr><th>Business</th><th>Risk</th><th>Approvals</th><th>Submitted</th><th>Status</th></tr></thead>
          <tbody>{rows.map((b) => (
            <tr key={b.id} className="clickable" onClick={() => setSel(b.id)}>
              <td>{b.legalName}</td><td>{b.riskTier}{b.riskReasons.length ? <div className="muted">{b.riskReasons.join(', ')}</div> : null}</td>
              <td>{b.approvals}/{b.approvalsNeeded}</td><td>{fmtIST(b.submittedAt)}</td><td><span className="pill">{b.status}</span></td>
            </tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">Nothing here.</p>}
      </div>
    </>
  );
}

export default function Page() { return <Shell><Businesses /></Shell>; }
