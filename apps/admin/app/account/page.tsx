'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Shell, useStaff } from '../components/Shell';
import { api, ApiError } from '../lib/api';

function Account() {
  const staff = useStaff() as ReturnType<typeof useStaff> & { mustChangePassword?: boolean };
  const router = useRouter();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.next !== f.again) { setErr('The new passwords don\'t match.'); return; }
    try { await api('/admin/me/password', { method: 'POST', body: { current: f.current, next: f.next } }); setOk(true); setTimeout(() => router.replace('/'), 800); }
    catch (e2) { setErr(e2 instanceof ApiError ? (e2.issues?.[0]?.message ?? e2.message) : 'Failed'); }
  };
  return (
    <form className="panel login" style={{ margin: '20px 0', maxWidth: 420 }} onSubmit={submit}>
      <h2>Change password</h2>
      {staff.mustChangePassword && <div className="note">This account has a one-time password. Choose your own before continuing.</div>}
      <label htmlFor="c">Current password</label><input id="c" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
      <label htmlFor="n">New password (12+ characters, letters and numbers)</label><input id="n" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
      <label htmlFor="a">New password again</label><input id="a" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required />
      <p><button>Change password</button></p>
      {err && <p className="err">{err}</p>}
      {ok && <p className="ok">Password changed.</p>}
    </form>
  );
}

export default function Page() { return <Shell><Account /></Shell>; }
