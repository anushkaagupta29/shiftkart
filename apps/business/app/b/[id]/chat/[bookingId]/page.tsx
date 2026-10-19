'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../../../../components/Shell';
import { api, errText, ist } from '../../../../lib/api';

type Msg = { id: string; from: string; body: string; flags: string[]; status: string; at: string };

function Chat() {
  const { id, bookingId } = useParams<{ id: string; bookingId: string }>();
  const [d, setD] = useState<{ open: boolean; messages: Msg[]; closesAt: string } | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => { api(`/businesses/${id}/bookings/${bookingId}/chat`).then(setD).catch((e) => setErr(errText(e))); }, [id, bookingId]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setNote('');
    try { const r = await api(`/businesses/${id}/bookings/${bookingId}/chat`, { method: 'POST', body: { text } }); setText(''); if (r.notice) setNote(r.notice); load(); } catch (e2) { setErr(errText(e2)); }
  };
  if (!d) return <p className="muted">{err || 'Loading…'}</p>;
  return (
    <>
      <h2>Chat with worker</h2>
      <p className="muted">Phone numbers stay hidden on both sides. Messages asking for money, payment IDs, OTPs or links are blocked. Chat closes {ist(d.closesAt)}.</p>
      <div className="panel">
        {d.messages.map((m) => (
          <div key={m.id} style={{ textAlign: m.from === 'me' ? 'right' : 'left', margin: '6px 0' }}>
            <span className="pill" style={{ background: m.from === 'system' ? 'var(--warn-bg)' : undefined, display: 'inline-block', maxWidth: '80%', textAlign: 'left', padding: '6px 10px' }}>{m.body}</span>
            <div className="muted" style={{ fontSize: 12 }}>{ist(m.at, { timeStyle: 'short' })}{m.status === 'blocked' && <span className="err"> · not sent</span>}
              {m.from === 'worker' && <> · <a href="#" onClick={async (e) => { e.preventDefault(); await api(`/businesses/${id}/messages/${m.id}/report`, { method: 'POST', body: { reason: 'Reported by business' } }); setNote('Reported.'); }}>report</a></>}</div>
          </div>
        ))}
        {d.messages.length === 0 && <p className="muted">No messages yet.</p>}
      </div>
      {d.open ? (
        <form className="panel row" onSubmit={send}>
          <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message (gate number, landmark, what to bring…)" />
          <button disabled={!text.trim()}>Send</button>
          <button type="button" className="secondary" onClick={async () => { const c = await api(`/businesses/${id}/bookings/${bookingId}/call`, { method: 'POST' }); setNote(`Dial ${c.virtualNumber}, PIN ${c.pin} (sandbox: no real call).`); load(); }}>Call (number hidden)</button>
        </form>
      ) : <p className="note">This chat is closed.</p>}
      {note && <p className="note">{note}</p>}
      {err && <p className="err">{err}</p>}
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Chat /></Shell>; }
