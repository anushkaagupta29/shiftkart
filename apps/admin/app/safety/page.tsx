'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, fmtIST } from '../lib/api';

type S = { sos: { id: string; firstName: string; status: string; sharedWithContact: boolean; last: { lat: number; lng: number; accuracy_m: number; at: string } | null; at: string }[];
  incidents: { id: string; category: string; severity: string; status: string; anonymous: boolean; reporterType: string; business: string | null; siteId: string | null; description: string; at: string }[] };

function Safety() {
  const [d, setD] = useState<S | null>(null);
  const load = useCallback(() => { api<S>('/admin/safety').then(setD); }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <>
      <h2>Safety desk</h2>
      <h3>SOS {d.sos.length > 0 && <span className="err">({d.sos.length} open)</span>}</h3>
      {d.sos.length === 0 && <div className="panel muted">No open SOS.</div>}
      {d.sos.map((s) => (
        <div className="panel" key={s.id} style={{ borderColor: 'var(--danger)' }}>
          <b className="err">🆘 {s.firstName}</b> · {s.status} · {fmtIST(s.at)} {s.sharedWithContact && <span className="pill">trusted contact notified</span>}
          {s.last && <p>Last location {fmtIST(s.last.at)} (±{s.last.accuracy_m} m): <a target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${s.last.lat}&mlon=${s.last.lng}#map=17/${s.last.lat}/${s.last.lng}`}>map</a></p>}
          <Decide options={s.status === 'open' ? [['acknowledge', 'Acknowledge (calling now)'], ['resolve', 'Resolve']] : [['resolve', 'Resolve']]}
            onDecide={async (action, note) => { await api(`/admin/sos/${s.id}/${action}`, { method: 'POST', body: { note } }); load(); }} />
        </div>
      ))}
      <h3>Incidents</h3>
      {d.incidents.length === 0 && <div className="panel muted">No open incidents.</div>}
      {d.incidents.map((i) => (
        <div className="panel" key={i.id}>
          <span className={i.severity === 'low' ? 'pill' : 'pill err'}>{i.severity}</span> <b>{i.category.replaceAll('_', ' ')}</b> · {i.anonymous ? 'anonymous' : `by ${i.reporterType}`} · {i.business ?? '—'} · {fmtIST(i.at)}
          <p>{i.description}</p>
          <p className="muted">To pause the site, use Business verification → the business → site, or the API (ops_safety). Pausing cancels its upcoming shifts and compensates workers.</p>
          <Decide options={[['in_progress', 'Mark in progress'], ['closed', 'Close']]} onDecide={async (status, outcome) => { await api(`/admin/incidents/${i.id}`, { method: 'POST', body: { status, outcome } }); load(); }} />
        </div>
      ))}
    </>
  );
}

export default function Page() { return <Shell><Safety /></Shell>; }
