'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, hasRole, useStaff } from '../components/Shell';
import { api, ApiError, fmtIST } from '../lib/api';

type User = { id: string; kind: string; status: string; preferredLang: string; phone: string; createdAt: string; lastLoginAt: string | null };
type Detail = User & { activeSessions: number; businesses: { id: string; legalName: string; role: string }[] };
type Page = { total: number; page: number; pageSize: number; items: User[] };

function UserDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const staff = useStaff();
  const [d, setD] = useState<Detail | null>(null);
  const [reason, setReason] = useState('');
  const [revealed, setRevealed] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => { api<Detail>(`/admin/users/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => { setRevealed(''); setMsg(''); setErr(''); load(); }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setErr(''); setMsg('');
    try { await fn(); setReason(''); } catch (e) { setErr(e instanceof ApiError ? (e.issues?.[0]?.message ?? e.message) : 'Failed'); }
  };
  const reveal = () => act(async () => {
    const r = await api<{ phone: string }>(`/admin/users/${id}/reveal-phone`, { method: 'POST', body: { reason } });
    setRevealed(r.phone); setMsg('Revealed. This action is in the audit log.');
  });
  const setStatus = (status: string) => act(async () => {
    await api(`/admin/users/${id}/status`, { method: 'POST', body: { status, reason } });
    setMsg(`Status set to ${status}.`); load(); onChanged();
  });

  if (!d) return <div className="panel">{err || 'Loading…'}</div>;
  const canReveal = hasRole(staff, ['ops_safety']);
  const canStatus = hasRole(staff, ['ops_safety', 'compliance']);
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>User <span className="mono">{d.id}</span></h3>
      <table><tbody>
        <tr><th>Phone</th><td className="mono">{revealed || d.phone}</td></tr>
        <tr><th>Kind</th><td>{d.kind}</td></tr>
        <tr><th>Status</th><td><span className="pill">{d.status}</span></td></tr>
        <tr><th>Language</th><td>{d.preferredLang}</td></tr>
        <tr><th>Signed up</th><td>{fmtIST(d.createdAt)}</td></tr>
        <tr><th>Last login</th><td>{fmtIST(d.lastLoginAt)}</td></tr>
        <tr><th>Active devices</th><td>{d.activeSessions}</td></tr>
        <tr><th>Businesses</th><td>{d.businesses.length ? d.businesses.map((b) => `${b.legalName} (${b.role})`).join(', ') : '—'}</td></tr>
      </tbody></table>
      {(canReveal || canStatus) && (
        <div style={{ marginTop: 14 }}>
          <div className="row">
            <input style={{ flex: 1, minWidth: 220 }} placeholder="Reason (required, goes in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {canReveal && <button className="secondary" onClick={reveal}>Reveal phone</button>}
            {canStatus && d.status !== 'limited' && <button className="secondary" onClick={() => setStatus('limited')}>Limit</button>}
            {canStatus && d.status !== 'suspended' && <button className="danger" onClick={() => setStatus('suspended')}>Suspend</button>}
            {canStatus && d.status !== 'active' && <button onClick={() => setStatus('active')}>Reactivate</button>}
          </div>
        </div>
      )}
      {!canReveal && <p className="muted">Phone numbers are masked for your role.</p>}
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function Users() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [phone, setPhone] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: '25', ...(kind && { kind }), ...(status && { status }) });
    api<Page>(`/admin/users?${qs}`).then(setData).catch((e) => setErr(e.message));
  }, [kind, status, page]);
  useEffect(load, [load]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await api<{ items: User[] }>('/admin/users/search', { method: 'POST', body: { phone } });
      setData({ total: r.items.length, page: 1, pageSize: 25, items: r.items });
      if (r.items[0]) setSelected(r.items[0].id);
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : 'Search failed'); }
  };

  return (
    <>
      <h2>Users</h2>
      <div className="panel row">
        <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
          <option value="">All kinds</option><option value="worker">Workers</option><option value="business">Business</option>
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option><option>active</option><option>limited</option><option>suspended</option>
        </select>
        <form onSubmit={search} className="row" style={{ marginLeft: 'auto' }}>
          <input placeholder="Find by exact phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button type="submit">Search</button>
          <button type="button" className="secondary" onClick={() => { setPhone(''); load(); }}>Clear</button>
        </form>
      </div>
      {err && <p className="err">{err}</p>}
      {selected && <UserDetail id={selected} onChanged={load} />}
      <div className="panel">
        <table>
          <thead><tr><th>Phone</th><th>Kind</th><th>Status</th><th>Lang</th><th>Signed up</th></tr></thead>
          <tbody>
            {data?.items.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => setSelected(u.id)}>
                <td className="mono">{u.phone}</td><td>{u.kind}</td><td><span className="pill">{u.status}</span></td><td>{u.preferredLang}</td><td>{fmtIST(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && (
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted">{data.total} total</span>
            <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button className="secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return <Shell><Users /></Shell>;
}
