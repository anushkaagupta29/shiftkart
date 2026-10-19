'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, fmtIST } from '../lib/api';

type Entry = { seq: number; at: string; actorType: string; actorEmail: string | null; actorId: string | null; action: string; targetType: string | null; targetId: string | null; reason: string | null; before: unknown; after: unknown };
type Page = { total: number; page: number; pageSize: number; items: Entry[] };
type Chain = { ok: boolean; checked: number; brokenAtSeq?: number };

function Audit() {
  const [data, setData] = useState<Page | null>(null);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [chain, setChain] = useState<Chain | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: '50', ...(action && { action }) });
    api<Page>(`/admin/audit?${qs}`).then(setData).catch(() => {});
  }, [page, action]);
  useEffect(load, [load]);

  return (
    <>
      <h2>Audit log</h2>
      <div className="panel row">
        <input placeholder="Filter by action, e.g. user.status_change" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} style={{ minWidth: 280 }} />
        <button className="secondary" onClick={() => api<Chain>('/admin/audit/verify').then(setChain)}>Verify hash chain</button>
        {chain && (chain.ok
          ? <span className="ok">Chain intact: {chain.checked} entries checked</span>
          : <span className="err">Chain broken at entry #{chain.brokenAtSeq}. History was altered.</span>)}
      </div>
      <div className="panel">
        <p className="muted" style={{ marginTop: 0 }}>Append-only. Entries can't be edited or deleted, even by admins.</p>
        <table>
          <thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Reason</th><th>Change</th></tr></thead>
          <tbody>
            {data?.items.map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td>{fmtIST(e.at)}</td>
                <td>{e.actorEmail ?? e.actorType}{e.actorType === 'user' && <span className="mono"> {e.actorId?.slice(0, 8)}</span>}</td>
                <td className="mono">{e.action}</td>
                <td className="mono">{e.targetType}{e.targetId ? `:${e.targetId.slice(0, 8)}` : ''}</td>
                <td>{e.reason ?? '—'}</td>
                <td className="mono"><pre>{e.before ? `before ${JSON.stringify(e.before)}\n` : ''}{e.after ? `after  ${JSON.stringify(e.after)}` : ''}</pre></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && (
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted">{data.total} entries</span>
            <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button className="secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return <Shell><Audit /></Shell>;
}
