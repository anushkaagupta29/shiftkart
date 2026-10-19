'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, ApiError, fmtIST } from '../lib/api';

type C = { id: string; kind: string; status: string; summary: string; worker: string; business: string; openedBy: string; ackDueAt: string; decideDueAt: string; overdue: boolean; timesheetId: string | null };
type Detail = Record<string, any> & { timeline: { actor_type: string; type: string; body: string; internal: boolean; created_at: string }[]; evidence: { attendance: any[]; chat: any[]; ratings: any[] } };

function CaseDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [text, setText] = useState('');
  const [decision, setDecision] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<Detail>(`/admin/disputes/${id}`).then(setD); }, [id]);
  useEffect(load, [load]);
  const act = async (body: object) => { setErr(''); try { await api(`/admin/disputes/${id}/action`, { method: 'POST', body }); setText(''); load(); onChange(); } catch (e) { setErr(e instanceof ApiError ? (e.issues?.[0]?.message ?? e.message) : 'Failed'); } };
  if (!d) return <div className="panel">Loading…</div>;
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{d.kind} · <span className="pill">{d.status}</span></h3>
      <h4>Timeline</h4>
      {d.timeline.map((e, i) => <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}><span className="muted">{fmtIST(e.created_at)} · {e.actor_type} · {e.type}{e.internal ? ' · INTERNAL' : ''}</span><div>{e.body}</div></div>)}
      <h4>Evidence</h4>
      <details open><summary>Attendance ({d.evidence.attendance.length})</summary><pre className="mono">{JSON.stringify(d.evidence.attendance, null, 1)}</pre></details>
      <details><summary>Chat ({d.evidence.chat.length})</summary>{d.evidence.chat.map((m: any, i: number) => <div key={i} className="mono">{fmtIST(m.created_at)} {m.sender_type}: {m.body} {m.status === 'blocked' ? '[BLOCKED]' : ''}</div>)}</details>
      <details><summary>Ratings ({d.evidence.ratings.length})</summary><pre className="mono">{JSON.stringify(d.evidence.ratings, null, 1)}</pre></details>
      {d.status !== 'decided' && (
        <>
          <div className="row" style={{ marginTop: 10 }}>
            {d.status === 'open' && <button onClick={() => act({ type: 'acknowledge' })}>Acknowledge</button>}
            <input style={{ flex: 1 }} placeholder="Message to both sides, or internal note" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="secondary" onClick={() => act({ type: 'message', body: text })}>Message both</button>
            <button className="secondary" onClick={() => act({ type: 'note', body: text })}>Internal note</button>
          </div>
          {d.kind === 'timesheet'
            ? <p className="muted">Decide timesheet disputes on the Timesheet disputes page (the money moves with the decision).</p>
            : <div className="row" style={{ marginTop: 10 }}>
                <input placeholder="Decision (e.g. Warning issued to business)" value={decision} onChange={(e) => setDecision(e.target.value)} style={{ flex: 1 }} />
                <button onClick={() => act({ type: 'decide', decision, reason: text })}>Decide (reason = text above)</button>
              </div>}
        </>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function Cases() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState<C[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const load = useCallback(() => { api<{ items: C[] }>(`/admin/disputes?pageSize=100${status ? `&status=${status}` : ''}`).then((r) => setRows(r.items)); }, [status]);
  useEffect(load, [load]);
  return (
    <>
      <h2>Dispute cases</h2>
      <div className="panel row">{['open', 'under_review', 'decided', ''].map((s) => <button key={s} className={status === s ? '' : 'secondary'} onClick={() => setStatus(s)}>{s ? s.replace('_', ' ') : 'all'}</button>)}</div>
      {sel && <CaseDetail id={sel} onChange={load} />}
      <div className="panel">
        <table><thead><tr><th>Case</th><th>Parties</th><th>Opened by</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => setSel(c.id)}><td>{c.kind}<div className="muted">{c.summary.slice(0, 120)}</div></td><td>{c.worker} / {c.business}</td><td>{c.openedBy}</td>
              <td className={c.overdue ? 'err' : ''}>ack {fmtIST(c.ackDueAt)}<br />decide {fmtIST(c.decideDueAt)}</td><td><span className="pill">{c.status}</span></td></tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">Nothing here.</p>}
      </div>
    </>
  );
}

export default function Page() { return <Shell><Cases /></Shell>; }
