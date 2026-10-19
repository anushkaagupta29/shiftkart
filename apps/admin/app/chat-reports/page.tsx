'use client';

import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, fmtIST } from '../lib/api';

type M = { id: string; from: string; body: string; flags: string[]; status: string; reportReason: string | null; reportedAt: string | null; business: string; worker: string };

function Reports() {
  const [rows, setRows] = useState<M[]>([]);
  useEffect(() => { api<M[]>('/admin/chat-reports').then(setRows); }, []);
  return (
    <>
      <h2>Chat reports</h2>
      <p className="muted">Messages someone reported, and messages from businesses that the filter blocked (money requests, links, OTP requests).</p>
      <div className="panel">
        <table><thead><tr><th>When</th><th>From</th><th>Between</th><th>Message</th><th>Why</th></tr></thead>
          <tbody>{rows.map((m) => (
            <tr key={m.id}><td>{fmtIST(m.reportedAt)}</td><td>{m.from}</td><td>{m.worker} / {m.business}</td><td>{m.body}</td><td>{m.reportReason ?? m.flags.join(', ')} {m.status === 'blocked' && <span className="pill">blocked</span>}</td></tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">Nothing reported.</p>}
      </div>
    </>
  );
}

export default function Page() { return <Shell><Reports /></Shell>; }
