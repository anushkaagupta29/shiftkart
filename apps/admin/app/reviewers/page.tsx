'use client';

import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api } from '../lib/api';

function Reviewers() {
  const [rows, setRows] = useState<{ email: string; approved: number; later_flagged: number }[]>([]);
  useEffect(() => { api<{ email: string; approved: number; later_flagged: number }[]>('/admin/reviewers').then(setRows); }, []);
  return (
    <>
      <h2>Verifier oversight</h2>
      <p className="muted">How many businesses each verifier approved, and how many later had a serious fraud flag. A random sample of approvals is also sent for a second look.</p>
      <div className="panel"><table><thead><tr><th>Verifier</th><th>Approved</th><th>Later flagged</th><th>Rate</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.email}><td>{r.email}</td><td>{r.approved}</td><td>{r.later_flagged}</td><td>{r.approved ? Math.round((r.later_flagged / r.approved) * 100) : 0}%</td></tr>)}</tbody></table></div>
    </>
  );
}

export default function Page() { return <Shell><Reviewers /></Shell>; }
