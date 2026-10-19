'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText, ist } from '../../../lib/api';

type C = { id: string; kind: string; status: string; summary: string; shiftTitle: string | null; createdAt: string; decideDueAt: string };

function Disputes() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<C[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api<C[]>(`/businesses/${id}/disputes`).then(setRows).catch((e) => setErr(errText(e))); }, [id]);
  return (
    <>
      <h2>Disputes</h2>
      <p className="muted">Every dispute has a timeline you and the worker can both see. Our team acknowledges within 24 hours and decides within 5 days, with the reason shown to both sides.</p>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <table><thead><tr><th>Shift</th><th>Type</th><th>Summary</th><th>Status</th><th>Decision due</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}><td><Link href={`/b/${id}/disputes/${c.id}`}>{c.shiftTitle ?? '—'}</Link></td><td>{c.kind}</td><td>{c.summary}</td><td><span className="pill">{c.status.replace('_', ' ')}</span></td><td>{ist(c.decideDueAt)}</td></tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">No disputes.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Disputes /></Shell>; }
