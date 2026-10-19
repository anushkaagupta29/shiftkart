'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, errText, rupees } from '../../lib/api';

/** Stand-in for a payment provider's hosted checkout (sandbox). Nothing real is charged. */
function MockCheckout() {
  const { intentId } = useParams<{ intentId: string }>();
  const q = useSearchParams();
  const router = useRouter();
  const b = q.get('b'), s = q.get('s');
  const [intent, setIntent] = useState<{ amountPaise: number; orderRef: string; status: string } | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (b) api(`/businesses/${b}/payments/${intentId}`).then(setIntent).catch((e) => setMsg(errText(e))); }, [b, intentId]);
  const pay = async (outcome: 'success' | 'failure') => {
    setMsg('Processing…');
    try {
      await api(`/mockpay/checkout/${intentId}`, { method: 'POST', body: { outcome } });
      if (outcome === 'success') router.push(`/b/${b}/shifts/${s}`);
      else setMsg('Payment failed. Nothing was charged, and the shift is not published.');
    } catch (e) { setMsg(errText(e)); }
  };
  return (
    <div className="login panel" style={{ maxWidth: 420 }}>
      <div className="note">SANDBOX: mock payment provider. No real money moves.</div>
      <h2>MockPay checkout</h2>
      {intent && <p>Pay <b>{rupees(intent.amountPaise)}</b> to ShiftKart escrow<br /><span className="muted mono">{intent.orderRef}</span></p>}
      <p className="row"><button onClick={() => pay('success')}>Pay (simulate success)</button><button className="secondary" onClick={() => pay('failure')}>Simulate failure</button></p>
      {msg && <p>{msg}</p>}
    </div>
  );
}

export default function Page() { return <Suspense><MockCheckout /></Suspense>; }
