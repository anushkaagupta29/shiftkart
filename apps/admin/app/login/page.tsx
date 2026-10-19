'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/auth/login', { method: 'POST', body: { email, password, totp } });
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the API. Is `npm run dev` running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login panel">
      <h2>Staff login</h2>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label htmlFor="totp">2FA code</label>
        <input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required />
        {error && <p className="err">{error}</p>}
        <p><button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></p>
        <p className="muted">Local dev: get a 2FA code with <span className="mono">npm run totp -- &lt;email&gt;</span></p>
      </form>
    </div>
  );
}
