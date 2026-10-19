'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText } from '../../../lib/api';

function Verify() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [f, setF] = useState({ gstin: '', udyamOrSeNo: '', pan: '', signatoryName: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value.toUpperCase() });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()));
    if (body.signatoryName) body.signatoryName = f.signatoryName;
    try { await api(`/businesses/${id}/verification`, { method: 'PUT', body }); router.push(`/b/${id}`); } catch (e2) { setErr(errText(e2)); }
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Verify your business</h2>
      <p className="muted">We check your GSTIN with the GST network and confirm your PAN matches. A business can&apos;t post shifts until it&apos;s verified.
        This protects workers from fake job posts.</p>
      <div className="form-grid">
        <div><label htmlFor="g">GSTIN</label><input id="g" value={f.gstin} onChange={set('gstin')} placeholder="29ABCDE1234F1Z5" /></div>
        <div><label htmlFor="u">Or Udyam / Shops &amp; Establishments no.</label><input id="u" value={f.udyamOrSeNo} onChange={set('udyamOrSeNo')} /></div>
        <div><label htmlFor="p">PAN</label><input id="p" value={f.pan} onChange={set('pan')} required placeholder="ABCDE1234F" /></div>
        <div><label htmlFor="s">Authorised signatory (full name)</label><input id="s" value={f.signatoryName} onChange={(e) => setF({ ...f, signatoryName: e.target.value })} required /></div>
      </div>
      <p className="muted">Local dev: GSTIN <span className="mono">29ABCDE1234F1Z5</span> is the sample business&apos;s. Any other valid GSTIN is &quot;not found&quot; in the mock and needs two reviewers.</p>
      <p><button>Submit</button></p>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Verify /></Shell>; }
