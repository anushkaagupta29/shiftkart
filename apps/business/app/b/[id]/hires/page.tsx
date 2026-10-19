'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText, ist, rupees } from '../../../lib/api';

type H = { id: string; status: string; roleTitle: string; workerFirstName: string; feePaise: number; gstPaise: number; contact: string | null; createdAt: string };

function Hires() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [rows, setRows] = useState<H[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api<H[]>(`/businesses/${id}/hire-requests`).then(setRows).catch((e) => setErr(errText(e))); }, [id]);
  return (
    <>
      <h2>Full-time hires</h2>
      <p className="muted">Want to hire someone you met through ShiftKart? Make an offer from the shift page. If they say yes, a one-time fee unlocks each other&apos;s contact details. The worker is never charged and is free to say no.</p>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <table><thead><tr><th>Worker</th><th>Role</th><th>Status</th><th>Fee</th><th>Contact</th><th /></tr></thead>
          <tbody>{rows.map((h) => (
            <tr key={h.id}><td>{h.workerFirstName}</td><td>{h.roleTitle}<div className="muted">{ist(h.createdAt)}</div></td><td><span className="pill">{h.status}</span></td>
              <td>{rupees(h.feePaise)} + GST {rupees(h.gstPaise)}</td><td className="mono">{h.contact ?? '—'}</td>
              <td>{h.status === 'accepted' && <button onClick={async () => { try { const p = await api(`/businesses/${id}/hire-requests/${h.id}/pay`, { method: 'POST' }); router.push(`/pay/${p.intentId}?b=${id}&s=`); } catch (e) { setErr(errText(e)); } }}>Pay fee</button>}</td></tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">No offers yet.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Hires /></Shell>; }
