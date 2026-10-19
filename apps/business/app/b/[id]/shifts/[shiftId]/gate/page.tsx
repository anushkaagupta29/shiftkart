'use client';

import QRCode from 'qrcode';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from '../../../../../components/Shell';
import { api, errText, ist } from '../../../../../lib/api';
import { gateCodeFor, stepAt } from '../../../../../lib/gate';

type Gate = { shiftId: string; siteName: string; title: string; keyB64: string; periodSec: number; serverTime: string; closesAt: string };
type Row = { bookingId: string; firstName: string; status: string; onBreak: boolean; checkedInAt: string | null; checkedOutAt: string | null; flags: string[]; manual: boolean; failedAttempts: number; overtime: { status: string; extraMinutes: number } | null };

const FLAG_TEXT: Record<string, string> = {
  mock_location: 'Fake-GPS app detected', device_integrity_fail: 'Phone failed security check', low_gps_accuracy: 'Weak GPS signal',
  integrity_missing: 'No phone security check', offline_sync: 'Checked in offline', clock_mismatch: 'Phone clock was wrong',
  stayed_late_no_overtime: 'Stayed late with no overtime agreed', manual_by_supervisor: 'Marked by supervisor',
};

/** Supervisor's gate screen: rotating QR + 6-digit code, live roster, and the offline fallback. */
function GateScreen() {
  const { id, shiftId } = useParams<{ id: string; shiftId: string }>();
  const [gate, setGate] = useState<Gate | null>(null);
  const [offset, setOffset] = useState(0); // server clock − phone clock
  const [code, setCode] = useState('');
  const [qr, setQr] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [online, setOnline] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    api<Gate>(`/businesses/${id}/shifts/${shiftId}/gate`).then((g) => {
      setGate(g);
      setOffset(Date.parse(g.serverTime) - Date.now());
      try { sessionStorage.setItem(`gate:${shiftId}`, JSON.stringify(g)); } catch { /* ignore */ }
    }).catch((e) => {
      // No network: keep showing codes from the key we already have.
      const cached = (() => { try { return sessionStorage.getItem(`gate:${shiftId}`); } catch { return null; } })();
      if (cached) { setGate(JSON.parse(cached)); setOnline(false); } else setErr(errText(e));
    });
  }, [id, shiftId]);

  useEffect(() => {
    if (!gate) return;
    let alive = true;
    const tick = async () => {
      const now = Date.now() + offset;
      const step = stepAt(now, gate.periodSec);
      const c = await gateCodeFor(gate.keyB64, step);
      if (!alive) return;
      setCode(c);
      setSecondsLeft(gate.periodSec - Math.floor((now / 1000) % gate.periodSec));
      setQr(await QRCode.toDataURL(`sk1.${gate.shiftId}.${step}.${c}`, { margin: 1, width: 320 }));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [gate, offset]);

  const loadRoster = useCallback(() => {
    api<Row[]>(`/businesses/${id}/shifts/${shiftId}/attendance`).then((r) => { setRows(r); setOnline(true); }).catch(() => setOnline(false));
  }, [id, shiftId]);
  useEffect(() => { loadRoster(); const t = setInterval(loadRoster, 10_000); return () => clearInterval(t); }, [loadRoster]);

  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); loadRoster(); } catch (e) { setErr(errText(e)); } };
  const manual = (r: Row, type: 'check_in' | 'check_out') => {
    const reason = prompt(`Mark ${r.firstName} as ${type === 'check_in' ? 'arrived' : 'left'} by hand? This is for when the app can't be used. The worker must confirm it later. Reason:`);
    if (reason) act(() => api(`/businesses/${id}/bookings/${r.bookingId}/manual`, { method: 'POST', body: { type, at: new Date().toISOString(), reason } }));
  };
  const overtime = (r: Row) => {
    const mins = prompt(`Ask ${r.firstName} to stay longer. How many extra minutes (15–240)? You pay for it first; ${r.firstName} can say no.`);
    if (mins) act(async () => {
      const o = await api(`/businesses/${id}/bookings/${r.bookingId}/overtime`, { method: 'POST', body: { extraMinutes: Number(mins) } });
      window.location.href = `/pay/${o.intentId}?b=${id}&s=${shiftId}`;
    });
  };

  if (err && !gate) return <div className="panel"><p className="err">{err}</p></div>;
  if (!gate) return <p className="muted">Loading…</p>;
  return (
    <>
      <h2>Gate: {gate.title}</h2>
      {!online && <div className="note">No connection. The code below still works; the list will update when you are back online.</div>}
      <div className="panel" style={{ textAlign: 'center' }}>
        <p className="muted" style={{ margin: 0 }}>Workers scan this, or type the code. It changes every {gate.periodSec} seconds.</p>
        {qr && <img src={qr} alt="Check-in QR code" width={300} height={300} style={{ imageRendering: 'pixelated', margin: '8px auto', display: 'block' }} />}
        <div data-testid="gate-code" className="mono" style={{ fontSize: 56, letterSpacing: 8, fontWeight: 700 }}>{code}</div>
        <div className="muted">new code in {secondsLeft}s · {gate.siteName}</div>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Workers ({rows.filter((r) => r.checkedInAt).length}/{rows.length} arrived)</h3>
        <table>
          <thead><tr><th>Name</th><th>Status</th><th>In / out</th><th>Check</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.bookingId}>
              <td><b>{r.firstName}</b></td>
              <td>{r.onBreak ? 'On break' : r.status.replace('_', ' ')}{r.overtime && <div className="muted">overtime: {r.overtime.status.replace('_', ' ')} ({r.overtime.extraMinutes} min)</div>}</td>
              <td>{r.checkedInAt ? ist(r.checkedInAt, { timeStyle: 'short' }) : '—'} / {r.checkedOutAt ? ist(r.checkedOutAt, { timeStyle: 'short' }) : '—'}</td>
              <td>{r.flags.length || r.failedAttempts ? (
                <span className="err">⚠ {r.flags.map((f) => FLAG_TEXT[f] ?? f).join(', ')}{r.failedAttempts ? ` · ${r.failedAttempts} failed tries` : ''}<br /><span className="muted">Please check this is the person in the app photo.</span></span>
              ) : r.checkedInAt ? <span className="ok">OK</span> : ''}</td>
              <td className="row">
                {r.status === 'confirmed' && <button className="secondary" onClick={() => manual(r, 'check_in')}>Mark arrived</button>}
                {r.status === 'checked_in' && (
                  <>
                    <button className="secondary" onClick={() => act(() => api(`/businesses/${id}/bookings/${r.bookingId}/break`, { method: 'POST', body: { action: r.onBreak ? 'end' : 'start' } }))}>{r.onBreak ? 'End break' : 'Start break'}</button>
                    <button className="secondary" onClick={() => overtime(r)}>Ask to stay</button>
                    <button className="secondary" onClick={() => manual(r, 'check_out')}>Mark left</button>
                  </>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table>
        {rows.length === 0 && <p className="muted">No one booked yet.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><GateScreen /></Shell>; }
