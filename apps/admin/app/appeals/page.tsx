'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, hasRole, useStaff } from '../components/Shell';
import { Decide } from '../components/Decide';
import { api, fmtIST } from '../lib/api';

type A = { id: string; workerId: string; firstName: string; kind: string; points: number; emergency: boolean; shiftTitle: string; shiftStart: string; hoursBefore: number | null; appealReason: string; appealedAt: string };

function Appeals() {
  const staff = useStaff();
  const [rows, setRows] = useState<A[]>([]);
  const load = useCallback(() => { api<A[]>('/admin/appeals').then(setRows); }, []);
  useEffect(load, [load]);
  return (
    <>
      <h2>Strike appeals</h2>
      <p className="muted">Every strike can be appealed. Emergencies beyond the free limit land here too. Decide within 72 hours; the worker sees your reason.</p>
      {rows.length === 0 && <div className="panel muted">No open appeals.</div>}
      {rows.map((a) => (
        <div className="panel" key={a.id}>
          <b>{a.firstName}</b> · {a.kind.replace('_', ' ')} ({a.points} pts){a.emergency && <span className="pill"> emergency</span>}
          <div className="muted">{a.shiftTitle} · {fmtIST(a.shiftStart)}{a.hoursBefore != null ? ` · cancelled ${a.hoursBefore} h before` : ''} · appealed {fmtIST(a.appealedAt)}</div>
          <p>“{a.appealReason}”</p>
          {hasRole(staff, ['ops_disputes']) && <Decide options={[['overturn', 'Remove strike'], ['uphold', 'Keep strike', 'danger']]} onDecide={async (decision, reason) => { await api(`/admin/appeals/${a.id}/decide`, { method: 'POST', body: { decision, reason } }); load(); }} />}
        </div>
      ))}
    </>
  );
}

export default function Page() { return <Shell><Appeals /></Shell>; }
