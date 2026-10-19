'use client';

import { useState } from 'react';
import { ApiError } from '../lib/api';

/** Approve / reject with a required reason. Every decision goes to the audit log. */
export function Decide({ onDecide, approveLabel = 'Approve', rejectLabel = 'Reject', options }: {
  onDecide: (decision: string, reason: string) => Promise<void>; approveLabel?: string; rejectLabel?: string; options?: [string, string, string?][];
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (d: string) => {
    setBusy(true); setErr('');
    try { await onDecide(d, reason); setReason(''); } catch (e) { setErr(e instanceof ApiError ? (e.issues?.[0]?.message ?? e.message) : 'Failed'); } finally { setBusy(false); }
  };
  const opts = options ?? [['approve', approveLabel], ['reject', rejectLabel, 'danger']];
  return (
    <div>
      <div className="row">
        <input style={{ flex: 1, minWidth: 220 }} placeholder="Reason (required, goes in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {opts.map(([v, label, kind]) => <button key={v} className={kind ?? ''} disabled={busy} onClick={() => go(v)}>{label}</button>)}
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
