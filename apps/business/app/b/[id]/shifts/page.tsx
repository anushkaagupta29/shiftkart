'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText, ist, rupees } from '../../../lib/api';

type S = { id: string; title: string; siteName: string; startsAt: string; endsAt: string; headcount: number; filled: number; status: string; totalPaise: number };
const LABEL: Record<string, string> = { pending_review: 'In review', pending_funding: 'Needs funding', live: 'Live', cancelled: 'Cancelled', completed: 'Completed' };

function Shifts() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<S[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<S[]>(`/businesses/${id}/shifts`).then(setRows).catch((e) => setErr(errText(e))); }, [id]);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}><h2>Shifts</h2><Link href={`/b/${id}/shifts/new`}><button>Post a shift</button></Link></div>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <table><thead><tr><th>Shift</th><th>When (IST)</th><th>Filled</th><th>Cost</th><th>Status</th></tr></thead>
          <tbody>{rows?.map((s) => (
            <tr key={s.id}>
              <td><Link href={`/b/${id}/shifts/${s.id}`}>{s.title}</Link><div className="muted">{s.siteName}</div></td>
              <td>{ist(s.startsAt)} – {ist(s.endsAt, { timeStyle: 'short' })}</td>
              <td>{s.filled} / {s.headcount}</td><td className="cost">{rupees(s.totalPaise)}</td>
              <td className={s.status === 'live' ? 'status-live' : ''}>{LABEL[s.status] ?? s.status}</td>
            </tr>
          ))}</tbody>
        </table>
        {rows?.length === 0 && <p className="muted">No shifts yet.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Shifts /></Shell>; }
