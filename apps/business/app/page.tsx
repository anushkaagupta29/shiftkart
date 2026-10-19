'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { api, errText } from './lib/api';

type Biz = { id: string; legalName: string; tradeName: string | null; verificationStatus: string; myRole: string };

function Home() {
  const [list, setList] = useState<Biz[] | null>(null);
  const [legalName, setLegalName] = useState('');
  const [tradeName, setTradeName] = useState('');
  const [err, setErr] = useState('');
  const load = () => api<Biz[]>('/businesses').then(setList).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, []);
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('/businesses', { method: 'POST', body: { legalName, ...(tradeName ? { tradeName } : {}) } }); setLegalName(''); setTradeName(''); load(); }
    catch (e2) { setErr(errText(e2)); }
  };
  return (
    <>
      <h2>Your businesses</h2>
      {list?.length === 0 && <p className="muted">No business yet. Add one below.</p>}
      <div className="grid">
        {list?.map((b) => (
          <Link key={b.id} href={`/b/${b.id}`} className="stat" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div style={{ fontWeight: 600 }}>{b.tradeName ?? b.legalName}</div>
            <div className="l">{b.legalName}</div>
            <div style={{ marginTop: 6 }}><span className="pill">{b.verificationStatus}</span> <span className="muted">{b.myRole}</span></div>
          </Link>
        ))}
      </div>
      <form className="panel" style={{ marginTop: 20 }} onSubmit={create}>
        <h3 style={{ marginTop: 0 }}>Add a business</h3>
        <div className="form-grid">
          <div><label htmlFor="ln">Legal name (as on GST)</label><input id="ln" value={legalName} onChange={(e) => setLegalName(e.target.value)} required /></div>
          <div><label htmlFor="tn">Trade name (optional)</label><input id="tn" value={tradeName} onChange={(e) => setTradeName(e.target.value)} /></div>
        </div>
        <p><button>Create</button></p>
        {err && <p className="err">{err}</p>}
      </form>
    </>
  );
}

export default function Page() { return <Shell><Home /></Shell>; }
