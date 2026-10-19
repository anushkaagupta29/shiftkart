'use client';

import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { api, fmtIST } from '../lib/api';

type P = { key: string; scope: string; value: unknown; effectiveFrom: string; reason: string };

function Policy() {
  const [rows, setRows] = useState<P[]>([]);
  useEffect(() => { api<P[]>('/admin/policy').then(setRows).catch(() => {}); }, []);
  return (
    <>
      <h2>Policy values</h2>
      <div className="note">All values are placeholders pending legal review (docs/LEGAL_CHECKLIST.md). Money is in paise, rates in basis points (100 bp = 1%). Editing with two-person approval arrives in Phase 2.</div>
      <div className="panel">
        <table>
          <thead><tr><th>Key</th><th>Scope</th><th>Value</th><th>Effective from</th><th>Reason</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.key}:${p.scope}`}>
                <td className="mono">{p.key}</td><td>{p.scope}</td><td className="mono"><pre>{JSON.stringify(p.value)}</pre></td><td>{fmtIST(p.effectiveFrom)}</td><td className="muted">{p.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Page() {
  return <Shell><Policy /></Shell>;
}
