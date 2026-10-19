'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText } from '../../../lib/api';

function Report() {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const [cat, setCat] = useState(q.get('category') ?? 'unsafe_site');
  const [desc, setDesc] = useState('');
  const [anon, setAnon] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const bookingId = q.get('booking');
  return (
    <form className="panel" onSubmit={async (e) => {
      e.preventDefault(); setErr('');
      try { const r = await api(`/businesses/${id}/incidents`, { method: 'POST', body: { category: cat, description: desc, anonymous: anon, ...(bookingId ? { bookingId } : {}) } }); setMsg(r.message); setDesc(''); } catch (e2) { setErr(errText(e2)); }
    }}>
      <h2>Report a problem</h2>
      <p className="muted">Goes to a person on our safety team. Use this for harassment, injuries, unsafe conditions, or a worker who looks under 18.</p>
      <div className="form-grid">
        <div><label htmlFor="c">What happened</label>
          <select id="c" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="unsafe_site">Unsafe conditions</option><option value="injury">Injury</option><option value="harassment">Harassment</option>
            <option value="discrimination">Discrimination</option>{bookingId && <option value="underage_worker">Worker may be under 18</option>}<option value="other">Other</option>
          </select></div>
      </div>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="d">Details</label><textarea id="d" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} required /></div>
      {!bookingId && <label className="row"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} /> Report anonymously (we won&apos;t record who reported, and can&apos;t reply)</label>}
      <p><button disabled={desc.trim().length < 10}>Send report</button></p>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </form>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Suspense><Report /></Suspense></Shell>; }
