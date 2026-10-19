'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../components/Shell';
import { api, errText, ist } from '../../lib/api';

type Biz = { id: string; legalName: string; tradeName: string | null; verificationStatus: string; myRole: string };
type Ver = { status: string; gstin: string | null; submittedAt: string | null; verifiedAt: string | null; decisionReason: string | null };

const STEPS: Record<string, string> = {
  draft: 'Add a work site, then submit your business documents for verification.',
  pending: 'Our team is checking your documents. This usually takes less than a working day.',
  verified: 'Verified. You can post shifts.',
  rejected: 'Verification was not approved. Fix the issue below and submit again.',
  suspended: 'This account is suspended. Contact support.',
};

function Overview() {
  const { id } = useParams<{ id: string }>();
  const [b, setB] = useState<Biz | null>(null);
  const [v, setV] = useState<Ver | null>(null);
  const [sites, setSites] = useState<{ status: string }[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    Promise.all([api<Biz>(`/businesses/${id}`), api<Ver>(`/businesses/${id}/verification`), api(`/businesses/${id}/sites`)])
      .then(([x, y, z]) => { setB(x); setV(y); setSites(z); }).catch((e) => setErr(errText(e)));
  }, [id]);
  if (err) return <p className="err">{err}</p>;
  if (!b || !v) return <p className="muted">Loading…</p>;
  return (
    <>
      <h2>{b.tradeName ?? b.legalName}</h2>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Verification: <span className="pill">{v.status}</span></h3>
        <p>{STEPS[v.status]}</p>
        {v.decisionReason && v.status === 'rejected' && <p className="err">Reason: {v.decisionReason}</p>}
        {v.submittedAt && <p className="muted">Submitted {ist(v.submittedAt)}{v.verifiedAt ? ` · verified ${ist(v.verifiedAt)}` : ''}</p>}
        <div className="row">
          {['draft', 'rejected'].includes(v.status) && sites.length === 0 && <Link href={`/b/${id}/sites`}><button>Add a work site</button></Link>}
          {['draft', 'rejected'].includes(v.status) && sites.length > 0 && b.myRole === 'owner' && <Link href={`/b/${id}/verify`}><button>Submit for verification</button></Link>}
          {v.status === 'verified' && <Link href={`/b/${id}/shifts/new`}><button>Post a shift</button></Link>}
        </div>
      </div>
      <div className="panel">
        <p style={{ margin: 0 }}><b>How it works:</b> you fund each shift before it goes live. Workers see full pay up front, are paid within
          24 hours of your approval, and never pay anything to get work.</p>
      </div>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Overview /></Shell>; }
