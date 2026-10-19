'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, useStaff } from '../components/Shell';
import { api, ApiError, fmtIST } from '../lib/api';

const ROLES = ['ops_support', 'ops_verifier', 'ops_disputes', 'ops_safety', 'finance', 'compliance', 'super_admin'];
type StaffRow = { id: string; email: string; name: string; roles: string[]; status: string; lastLoginAt: string | null };

function Staff() {
  const me = useStaff();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['ops_support']);
  const [reason, setReason] = useState('');
  const [created, setCreated] = useState<{ tempPassword: string; totpSecret: string } | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => { api<StaffRow[]>('/admin/staff').then(setRows).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);

  const errMsg = (e: unknown) => (e instanceof ApiError ? (e.issues?.[0]?.message ?? e.message) : 'Failed');

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setCreated(null);
    try {
      setCreated(await api('/admin/staff', { method: 'POST', body: { email, name, roles, reason } }));
      setEmail(''); setName(''); setReason(''); load();
    } catch (e2) { setErr(errMsg(e2)); }
  };

  const disable = async (id: string) => {
    const why = window.prompt('Reason for disabling this account (goes in the audit log):');
    if (!why) return;
    try { await api(`/admin/staff/${id}/disable`, { method: 'POST', body: { reason: why } }); load(); } catch (e) { setErr(errMsg(e)); }
  };

  return (
    <>
      <h2>Staff</h2>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Roles</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.email}</td><td>{s.name}</td><td>{s.roles.join(', ')}</td><td><span className="pill">{s.status}</span></td><td>{fmtIST(s.lastLoginAt)}</td>
                <td>{s.id !== me.id && s.status === 'active' && <button className="secondary" onClick={() => disable(s.id)}>Disable</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="panel" onSubmit={create}>
        <h3 style={{ marginTop: 0 }}>Add staff member</h3>
        <div className="row">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="row" style={{ margin: '10px 0' }}>
          {ROLES.map((r) => (
            <label key={r} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{r}
            </label>
          ))}
        </div>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <button type="submit">Create</button>
        </div>
        {created && (
          <div className="note" style={{ marginTop: 12 }}>
            Shown once. Give these to the new staff member privately:<br />
            Temporary password: <span className="mono">{created.tempPassword}</span><br />
            2FA secret (add to an authenticator app): <span className="mono">{created.totpSecret}</span>
          </div>
        )}
      </form>
    </>
  );
}

export default function Page() {
  return <Shell><Staff /></Shell>;
}
