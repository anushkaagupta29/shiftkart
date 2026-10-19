'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, hasRole, useStaff } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, ApiError } from '../lib/api';

type W = { id: string; stateCode: string; zone: string; wageCategory: string; basicPaisePerDay: number; vdaPaisePerDay: number; standardHoursPerDay: number; effectiveFrom: string; sourceRef: string; status: string; createdBy: string | null; approvedBy: string | null };
const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;

function Rates() {
  const staff = useStaff();
  const [rows, setRows] = useState<W[]>([]);
  const [f, setF] = useState({ stateCode: 'KA', zone: 'A', wageCategory: 'unskilled', basic: '', vda: '0', effectiveFrom: '', sourceRef: '', reason: '' });
  const [err, setErr] = useState('');
  const load = useCallback(() => { api<W[]>('/admin/wage-rates').then(setRows); }, []);
  useEffect(load, [load]);
  const canManage = hasRole(staff, ['compliance']);
  const propose = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      await api('/admin/wage-rates', { method: 'POST', body: { stateCode: f.stateCode, zone: f.zone, wageCategory: f.wageCategory, basicPaisePerDay: Math.round(Number(f.basic) * 100), vdaPaisePerDay: Math.round(Number(f.vda) * 100), effectiveFrom: f.effectiveFrom, sourceRef: f.sourceRef, reason: f.reason } });
      load();
    } catch (e2) { setErr(e2 instanceof ApiError ? (e2.issues?.[0]?.message ?? e2.message) : 'Failed'); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <h2>Minimum wage rates</h2>
      <div className="note">Seeded rates are SAMPLE values, not the real Karnataka notification (LEGAL_CHECKLIST L-04). A rate goes live only when a second compliance officer approves it, and can't be backdated.</div>
      <div className="panel">
        <table><thead><tr><th>State/zone</th><th>Category</th><th>Basic + VDA / day</th><th>Per hour</th><th>From</th><th>Source</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((w) => (
            <tr key={w.id}>
              <td>{w.stateCode} / {w.zone}</td><td>{w.wageCategory}</td><td>{rs(w.basicPaisePerDay)} + {rs(w.vdaPaisePerDay)}</td>
              <td>{rs(Math.ceil((w.basicPaisePerDay + w.vdaPaisePerDay) / w.standardHoursPerDay))}</td><td>{w.effectiveFrom}</td>
              <td className="muted">{w.sourceRef}<br />{w.createdBy && `by ${w.createdBy}`}{w.approvedBy && `, approved by ${w.approvedBy}`}</td>
              <td><span className="pill">{w.status}</span></td>
              <td>{w.status === 'pending' && canManage && <Decide onDecide={async (decision, reason) => { await api(`/admin/wage-rates/${w.id}/decide`, { method: 'POST', body: { decision, reason } }); load(); }} />}</td>
            </tr>
          ))}</tbody></table>
      </div>
      {canManage && (
        <form className="panel" onSubmit={propose}>
          <h3 style={{ marginTop: 0 }}>Propose a new rate</h3>
          <div className="row">
            <input value={f.stateCode} onChange={set('stateCode')} size={3} />
            <input value={f.zone} onChange={set('zone')} size={3} />
            <select value={f.wageCategory} onChange={set('wageCategory')}><option>unskilled</option><option>semi_skilled</option><option>skilled</option></select>
            <input placeholder="Basic ₹/day" value={f.basic} onChange={set('basic')} />
            <input placeholder="VDA ₹/day" value={f.vda} onChange={set('vda')} />
            <input type="date" value={f.effectiveFrom} onChange={set('effectiveFrom')} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ flex: 1 }} placeholder="Source (notification no. and date)" value={f.sourceRef} onChange={set('sourceRef')} />
            <input style={{ flex: 1 }} placeholder="Reason" value={f.reason} onChange={set('reason')} />
            <button>Propose</button>
          </div>
          {err && <p className="err">{err}</p>}
        </form>
      )}
    </>
  );
}

export default function Page() { return <Shell><Rates /></Shell>; }
