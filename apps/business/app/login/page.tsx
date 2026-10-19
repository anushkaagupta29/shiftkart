'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, errText } from '../lib/api';

function deviceId() {
  try {
    let id = localStorage.getItem('sk_device');
    if (!id) { id = `web-${crypto.randomUUID()}`; localStorage.setItem('sk_device', id); }
    return id;
  } catch { return `web-${crypto.randomUUID()}`; }
}

export default function Login() {
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'code' | 'consent'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState('');

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };

  const send = () => run(async () => { await api('/auth/otp/request', { method: 'POST', body: { phone } }); setStep('code'); });
  const verify = (signup?: object) => run(async () => {
    try {
      await api('/auth/otp/verify', { method: 'POST', body: { phone, code, deviceId: deviceId(), platform: 'web', client: 'web', ...(signup ? { signup } : {}) } });
      router.replace('/');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'signup_required') { setStep('consent'); return; }
      throw e;
    }
  });
  const showDevCode = async () => {
    const r = await api<{ body: string }[]>('/dev/outbox', { method: 'POST', body: { phone } }).catch(() => []);
    setDevCode(r[0]?.body.match(/\d{6}/)?.[0] ?? 'No code found');
  };

  return (
    <div className="login panel" style={{ maxWidth: 420 }}>
      <h2>ShiftKart for Business</h2>
      {step === 'phone' && (
        <form onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" inputMode="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <p><button disabled={busy}>Send code</button></p>
        </form>
      )}
      {step === 'code' && (
        <form onSubmit={(e) => { e.preventDefault(); verify(); }}>
          <label htmlFor="code">6-digit code sent to {phone}</label>
          <input id="code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          <p className="row"><button disabled={busy}>Continue</button><button type="button" className="secondary" onClick={() => setStep('phone')}>Change number</button></p>
          <p className="muted">Local dev: no SMS is sent. <a href="#" onClick={(e) => { e.preventDefault(); showDevCode(); }}>Show my code</a> {devCode && <b className="mono">{devCode}</b>}</p>
        </form>
      )}
      {step === 'consent' && (
        <div>
          <p>New number. Create a business account?</p>
          <div className="note">
            We collect your mobile number to log you in and contact you about your shifts. Business details you add
            (GSTIN, PAN, addresses) are used to verify your business. <b>Draft notice, pending legal review.</b>
          </div>
          <label className="row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree</label>
          <p><button disabled={!agree || busy} onClick={() => verify({ kind: 'business', lang: 'en', consents: ['account', 'notifications'] })}>Create account</button></p>
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
