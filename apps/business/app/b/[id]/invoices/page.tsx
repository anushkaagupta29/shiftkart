'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText, ist, rupees } from '../../../lib/api';

type Inv = {
  id: string; number: string; issuedAt: string; buyer: { legalName: string; gstin: string | null; stateCode: string | null }; seller: { legalName: string; gstin: string; stateCode: string; sac: string };
  lines: { description: string; sac: string; taxablePaise: number }[]; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number;
};

function Invoices() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<Inv[]>([]);
  const [sel, setSel] = useState<Inv | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Inv[]>(`/businesses/${id}/invoices`).then(setRows).catch((e) => setErr(errText(e))); }, [id]);
  return (
    <>
      <h2>Invoices</h2>
      <p className="muted">One GST invoice per shift for our fee, issued when the shift closes. Worker pay is not invoiced by us; unused money is refunded to how you paid.</p>
      {err && <p className="err">{err}</p>}
      {sel && (
        <div className="panel" id="invoice">
          <div className="note">DRAFT FORMAT: invoice layout, SAC code and seller GSTIN are pending (LEGAL_CHECKLIST L-12, L-32).</div>
          <h3 style={{ marginTop: 0 }}>Tax invoice {sel.number}</h3>
          <p>Issued {ist(sel.issuedAt)}</p>
          <div className="form-grid">
            <div><b>From</b><br />{sel.seller.legalName}<br />GSTIN {sel.seller.gstin} · {sel.seller.stateCode}</div>
            <div><b>To</b><br />{sel.buyer.legalName}<br />GSTIN {sel.buyer.gstin ?? '—'}</div>
          </div>
          <table className="cost" style={{ marginTop: 12 }}><tbody>
            {sel.lines.map((l, i) => <tr key={i}><td>{l.description} (SAC {l.sac})</td><td>{rupees(l.taxablePaise)}</td></tr>)}
            {sel.cgstPaise > 0 && <tr><td>CGST</td><td>{rupees(sel.cgstPaise)}</td></tr>}
            {sel.sgstPaise > 0 && <tr><td>SGST</td><td>{rupees(sel.sgstPaise)}</td></tr>}
            {sel.igstPaise > 0 && <tr><td>IGST</td><td>{rupees(sel.igstPaise)}</td></tr>}
            <tr className="total"><td>Total</td><td>{rupees(sel.totalPaise)}</td></tr>
          </tbody></table>
          <p className="row"><button className="secondary" onClick={() => window.print()}>Print / save as PDF</button><button className="secondary" onClick={() => setSel(null)}>Close</button></p>
        </div>
      )}
      <div className="panel">
        <table><thead><tr><th>Number</th><th>Issued</th><th>Fee</th><th>GST</th><th>Total</th></tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => setSel(i)}><td className="mono">{i.number}</td><td>{ist(i.issuedAt)}</td><td>{rupees(i.taxablePaise)}</td><td>{rupees(i.cgstPaise + i.sgstPaise + i.igstPaise)}</td><td>{rupees(i.totalPaise)}</td></tr>
          ))}</tbody></table>
        {rows.length === 0 && <p className="muted">No invoices yet.</p>}
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Invoices /></Shell>; }
