'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, errText } from '../lib/api';

type Grievance = { appointed: boolean; name: string | null; email: string | null; note: string | null };

/** DPDP data rights for business users (SPEC §6.12): download, delete, and who to complain to. */
function Privacy() {
  const router = useRouter();
  const [g, setG] = useState<Grievance | null>(null);
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api<Grievance>('/legal/grievance').then(setG).catch(() => {}); }, []);

  const download = async () => {
    setErr('');
    try {
      const data = await api('/me/export');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'shiftkart-my-data.json';
      a.click();
    } catch (e) { setErr(errText(e)); }
  };
  const del = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('/me/delete', { method: 'POST', body: { confirm: 'DELETE' } }); router.replace('/login?deleted=1'); }
    catch (e2) { setErr(errText(e2)); }
  };

  return (
    <>
      <h2>Privacy and your data</h2>
      {err && <p className="err" role="alert">{err}</p>}
      <section className="panel">
        <h3>Download your data</h3>
        <p className="muted">A copy of the personal data ShiftKart holds about you, as a JSON file.</p>
        <button onClick={download}>Download my data</button>
      </section>
      <section className="panel">
        <h3>Complaints about your data</h3>
        {g?.appointed ? <p>Grievance officer: {g.name} · <a href={`mailto:${g.email}`}>{g.email}</a></p> : <p className="muted">{g?.note ?? 'DRAFT: a grievance officer has not been appointed yet.'}</p>}
      </section>
      <section className="panel">
        <h3>Delete your account</h3>
        <p className="muted">Your number and contact details are removed and you are signed out everywhere. Invoices and payment records are kept as the law requires. If you own a business, transfer or close it first (contact support).</p>
        <form onSubmit={del}>
          <label>Type DELETE to confirm <input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <button className="danger" disabled={confirm !== 'DELETE'}>Delete my account</button>
        </form>
      </section>
    </>
  );
}

export default function Page() {
  return <Shell><Privacy /></Shell>;
}
