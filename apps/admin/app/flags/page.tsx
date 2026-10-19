'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, fmtIST } from '../lib/api';

type F = { id: string; subjectType: string; subjectId: string; rule: string; score: number; evidence: unknown; status: string; reviewReason: string | null; createdAt: string };
const EXPLAIN: Record<string, string> = {
  duplicate_identity: 'Same identity document as another account', duplicate_face: 'Same face as another account',
  duplicate_account: 'Bank/UPI shared with another worker', device_shared: 'Several worker accounts on one phone',
  selfie_kyc_mismatch: 'Selfie did not match ID photo', payout_name_review: 'Name at bank only partly matches ID',
  gstin_in_use: "Tried to use another business's GSTIN", payment_amount_mismatch: 'Payment amount did not match',
  funded_inactive_shift: 'Money arrived for a shift that cannot go live (refund needed)',
};

function Flags() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState<F[]>([]);
  const load = useCallback(() => { api<{ items: F[] }>(`/admin/flags?status=${status}&pageSize=100`).then((r) => setRows(r.items)); }, [status]);
  useEffect(load, [load]);
  return (
    <>
      <h2>Fraud flags</h2>
      <div className="panel row">{['open', 'confirmed', 'dismissed'].map((s) => <button key={s} className={status === s ? '' : 'secondary'} onClick={() => setStatus(s)}>{s}</button>)}</div>
      {rows.length === 0 && <div className="panel muted">No {status} flags.</div>}
      {rows.map((f) => (
        <div className="panel" key={f.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{EXPLAIN[f.rule] ?? f.rule}</b><span className="muted">score {f.score} · {fmtIST(f.createdAt)}</span>
          </div>
          <p className="mono">{f.subjectType}:{f.subjectId}</p>
          <pre className="mono">{JSON.stringify(f.evidence, null, 1)}</pre>
          {f.status === 'open'
            ? <Decide options={[['dismissed', 'Dismiss (not fraud)'], ['confirmed', 'Confirm fraud', 'danger']]} onDecide={async (decision, reason) => { await api(`/admin/flags/${f.id}/resolve`, { method: 'POST', body: { decision, reason } }); load(); }} />
            : <p className="muted">{f.status}: {f.reviewReason}</p>}
        </div>
      ))}
    </>
  );
}

export default function Page() { return <Shell><Flags /></Shell>; }
