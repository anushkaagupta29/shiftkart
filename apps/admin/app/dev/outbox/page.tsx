'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../../components/Shell';
import { api, fmtIST } from '../../lib/api';

type Msg = { channel: string; to: string; body: string; at: string };

function Outbox() {
  const [rows, setRows] = useState<Msg[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api<Msg[]>('/dev/outbox', { method: 'POST', body: {} }).then(setRows).catch(() => setErr('Dev endpoints are off (DEV_ENDPOINTS=false or production).'));
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <h2>SMS outbox (dev only)</h2>
      <div className="note">Nothing is really sent. In Phase 1, SMS goes to this table so you can read login codes. This page and its API endpoint don't exist in production.</div>
      <p><button className="secondary" onClick={load}>Refresh</button></p>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <table>
          <thead><tr><th>When</th><th>To</th><th>Message</th></tr></thead>
          <tbody>{rows?.map((m, i) => <tr key={i}><td>{fmtIST(m.at)}</td><td className="mono">{m.to}</td><td>{m.body}</td></tr>)}</tbody>
        </table>
        {rows?.length === 0 && <p className="muted">No messages yet.</p>}
      </div>
    </>
  );
}

export default function Page() {
  return <Shell><Outbox /></Shell>;
}
