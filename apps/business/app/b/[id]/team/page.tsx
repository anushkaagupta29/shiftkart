'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText, ist } from '../../../lib/api';

type M = { id: string; role: string; phone: string; addedAt: string };

function Team() {
  const { id } = useParams<{ id: string }>();
  const [members, setMembers] = useState<M[]>([]);
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('supervisor');
  const [err, setErr] = useState('');
  const load = () => api<M[]>(`/businesses/${id}/members`).then(setMembers).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, [id]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api(`/businesses/${id}/members`, { method: 'POST', body: { phone, role } }); setPhone(''); load(); } catch (e2) { setErr(errText(e2)); }
  };
  const remove = async (m: M) => {
    if (!confirm(`Remove ${m.phone}? They lose access immediately.`)) return;
    try { await api(`/businesses/${id}/members/${m.id}`, { method: 'DELETE' }); load(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <>
      <h2>Team</h2>
      <div className="panel">
        <table><thead><tr><th>Phone</th><th>Role</th><th>Added</th><th /></tr></thead>
          <tbody>{members.map((m) => <tr key={m.id}><td className="mono">{m.phone}</td><td>{m.role}</td><td>{ist(m.addedAt)}</td><td>{m.role !== 'owner' && <button className="secondary" onClick={() => remove(m)}>Remove</button>}</td></tr>)}</tbody>
        </table>
      </div>
      <form className="panel row" onSubmit={add}>
        <input placeholder="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value)}><option value="supervisor">Supervisor (checks people in)</option><option value="manager">Manager (posts shifts)</option></select>
        <button>Add</button>
      </form>
      {err && <p className="err">{err}</p>}
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Team /></Shell>; }
