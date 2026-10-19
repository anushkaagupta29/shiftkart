'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../../../../components/Shell';
import { api, errText, ist } from '../../../../lib/api';

type V = { status: string; summary: string; decideDueAt: string; decision: string | null; decisionReason: string | null; timeline: { by: string; type: string; body: string; at: string }[] };

function Case() {
  const { id, caseId } = useParams<{ id: string; caseId: string }>();
  const [c, setC] = useState<V | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<V>(`/businesses/${id}/disputes/${caseId}`).then(setC).catch((e) => setErr(errText(e))); }, [id, caseId]);
  useEffect(load, [load]);
  if (!c) return <p className="muted">{err || 'Loading…'}</p>;
  return (
    <>
      <h2>Dispute</h2>
      <p><span className="pill">{c.status.replace('_', ' ')}</span> · decision due {ist(c.decideDueAt)}</p>
      <div className="panel">
        {c.timeline.map((e, i) => (
          <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
            <div className="muted">{e.by === 'ops' ? 'ShiftKart' : e.by} · {e.type} · {ist(e.at)}</div>
            <div style={{ fontWeight: e.type === 'decision' ? 700 : 400 }}>{e.body}</div>
          </div>
        ))}
      </div>
      {['open', 'under_review'].includes(c.status) && (
        <form className="panel row" onSubmit={async (e) => { e.preventDefault(); try { await api(`/businesses/${id}/disputes/${caseId}/statements`, { method: 'POST', body: { body: text } }); setText(''); load(); } catch (e2) { setErr(errText(e2)); } }}>
          <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add your side or more detail" />
          <button disabled={text.trim().length < 2}>Add</button>
        </form>
      )}
      {err && <p className="err">{err}</p>}
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Case /></Shell>; }
