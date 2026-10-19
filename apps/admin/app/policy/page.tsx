'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, hasRole, useStaff } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, ApiError, fmtIST } from '../lib/api';

type P = { key: string; scope: string; value: unknown; effectiveFrom: string; reason: string };
type R = { id: string; key: string; value: unknown; reason: string; requestedBy: string; decision: string | null; decidedBy: string | null; effectiveFrom: string };

function Policy() {
  const staff = useStaff();
  const [rows, setRows] = useState<P[]>([]);
  const [reqs, setReqs] = useState<R[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const canManage = hasRole(staff, ['compliance']);
  const load = useCallback(() => {
    api<P[]>('/admin/policy').then(setRows).catch(() => {});
    if (canManage) api<R[]>('/admin/policy/requests').then(setReqs).catch(() => {});
  }, [canManage]);
  useEffect(load, [load]);
  const request = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { setErr('Value must be JSON, e.g. 1200 or [1,2]'); return; }
    try { await api('/admin/policy/requests', { method: 'POST', body: { key, value: parsed, reason } }); setValue(''); setReason(''); load(); }
    catch (e2) { setErr(e2 instanceof ApiError ? (e2.issues?.[0]?.message ?? e2.message) : 'Failed'); }
  };
  return (
    <>
      <h2>Policy values</h2>
      <div className="note">All values are placeholders pending legal review (docs/LEGAL_CHECKLIST.md). Money is in paise, rates in basis points (100 bp = 1%). A change takes effect only after a second compliance officer approves it.</div>
      {canManage && (
        <>
          <form className="panel" onSubmit={request}>
            <h3 style={{ marginTop: 0 }}>Request a change</h3>
            <div className="row">
              <select value={key} onChange={(e) => { setKey(e.target.value); setValue(JSON.stringify(rows.find((r) => r.key === e.target.value)?.value ?? '')); }} required>
                <option value="">Pick a key…</option>{rows.map((r) => <option key={r.key}>{r.key}</option>)}
              </select>
              <input className="mono" placeholder="New value (JSON)" value={value} onChange={(e) => setValue(e.target.value)} required />
              <input style={{ flex: 1 }} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
              <button>Request</button>
            </div>
            {err && <p className="err">{err}</p>}
          </form>
          {reqs.length > 0 && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Change requests</h3>
              <table><thead><tr><th>Key</th><th>New value</th><th>Asked by</th><th>Reason</th><th>Decision</th></tr></thead>
                <tbody>{reqs.map((r) => (
                  <tr key={r.id}><td className="mono">{r.key}</td><td className="mono">{JSON.stringify(r.value)}</td><td>{r.requestedBy}</td><td>{r.reason}</td>
                    <td>{r.decision ? `${r.decision} by ${r.decidedBy}` : r.requestedBy === staff.email ? <span className="muted">Waiting for a second officer</span>
                      : <Decide onDecide={async (decision, why) => { await api(`/admin/policy/requests/${r.id}/decide`, { method: 'POST', body: { decision, reason: why } }); load(); }} />}</td></tr>
                ))}</tbody></table>
            </div>
          )}
        </>
      )}
      <div className="panel">
        <table>
          <thead><tr><th>Key</th><th>Scope</th><th>Value</th><th>Effective from</th><th>Reason</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.key}:${p.scope}`}>
                <td className="mono">{p.key}</td><td>{p.scope}</td><td className="mono"><pre>{JSON.stringify(p.value)}</pre></td><td>{fmtIST(p.effectiveFrom)}</td><td className="muted">{p.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Page() {
  return <Shell><Policy /></Shell>;
}
