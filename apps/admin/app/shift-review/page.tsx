'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, fmtIST } from '../lib/api';

type S = { id: string; business: string; title: string; description: string; dressCode: string; bringItems: string; roleCode: string; startsAt: string; headcount: number; reasons: string[]; genderRequirement: { requirement: string; legalReason: string } | null };

function Review() {
  const [rows, setRows] = useState<S[]>([]);
  const load = useCallback(() => { api<S[]>('/admin/shifts/review').then(setRows); }, []);
  useEffect(load, [load]);
  return (
    <>
      <h2>Shift review</h2>
      <p className="muted">Posts flagged by the keyword screen (fees, discrimination, prohibited work, document requests), high-hazard roles,
        or a gender requirement. Gender requirements can only be approved by compliance.</p>
      {rows.length === 0 && <div className="panel muted">Queue is empty.</div>}
      {rows.map((s) => (
        <div className="panel" key={s.id}>
          <h3 style={{ marginTop: 0 }}>{s.title} <span className="muted">· {s.business}</span></h3>
          <p>{s.roleCode} · {s.headcount} people · {fmtIST(s.startsAt)}</p>
          <p className="note">Flagged: {s.reasons.join(', ').replaceAll('_', ' ')}</p>
          <table><tbody>
            <tr><th>Description</th><td>{s.description || '—'}</td></tr>
            <tr><th>Dress code</th><td>{s.dressCode || '—'}</td></tr>
            <tr><th>Bring</th><td>{s.bringItems || '—'}</td></tr>
            {s.genderRequirement && <tr><th>Gender requirement</th><td><b>{s.genderRequirement.requirement}</b>: {s.genderRequirement.legalReason}</td></tr>}
          </tbody></table>
          <div style={{ marginTop: 10 }}><Decide approveLabel="Allow" rejectLabel="Reject post" onDecide={async (decision, reason) => { await api(`/admin/shifts/${s.id}/review`, { method: 'POST', body: { decision, reason } }); load(); }} /></div>
        </div>
      ))}
    </>
  );
}

export default function Page() { return <Shell><Review /></Shell>; }
