'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Shell } from '../../../../components/Shell';
import { api, errText, istToIso, rupees, toPaise } from '../../../../lib/api';

type Ref = { roles: { code: string; name: { en: string }; wageCategory: string; skills: string[] }[]; skills: { code: string; name: { en: string } }[]; languages: string[] };
type Site = { id: string; name: string; status: string };
type Cost = { paidMinutes: number; perWorkerPayPaise: number; effectiveHourlyPaise: number; workerPayTotalPaise: number; allowancesTotalPaise: number; feePaise: number; gstOnFeePaise: number; totalPaise: number; feeBp: number; gstBp: number };
type Preview = { cost: Cost; wageCategory: string; minHourlyPaise: number; needsReview: string[] };

const LANG_NAMES: Record<string, string> = { en: 'English', hi: 'Hindi', kn: 'Kannada', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali', ur: 'Urdu' };
const tomorrow = () => new Date(Date.now() + 330 * 60_000 + 86400_000).toISOString().slice(0, 10);

function NewShift() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ref, setRef] = useState<Ref | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [f, setF] = useState({
    siteId: '', roleCode: 'warehouse_packing', title: '', description: '', date: tomorrow(), start: '09:00', end: '17:00', breakMinutes: '30',
    headcount: '5', payType: 'hourly', pay: '100', meal: '0', travel: '0', dressCode: '', bringItems: '',
    skills: [] as string[], languages: [] as string[], twoWheeler: false,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pErr, setPErr] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/reference').then(setRef);
    api<Site[]>(`/businesses/${id}/sites`).then((s) => { const act = s.filter((x) => x.status === 'active'); setSites(act); if (act[0]) setF((x) => ({ ...x, siteId: act[0]!.id })); });
  }, [id]);

  const body = useMemo(() => {
    const endDate = f.end <= f.start ? new Date(Date.parse(f.date) + 86400_000).toISOString().slice(0, 10) : f.date; // overnight shift
    return {
      siteId: f.siteId, roleCode: f.roleCode, title: f.title || 'Untitled shift', description: f.description,
      startsAt: istToIso(f.date, f.start), endsAt: istToIso(endDate, f.end), breakMinutes: Number(f.breakMinutes) || 0,
      headcount: Number(f.headcount) || 0, payType: f.payType, payPaise: toPaise(f.pay) ?? 0,
      mealAllowancePaise: toPaise(f.meal) ?? 0, travelAllowancePaise: toPaise(f.travel) ?? 0,
      requirements: { skills: f.skills, languages: f.languages, twoWheeler: f.twoWheeler }, dressCode: f.dressCode, bringItems: f.bringItems,
    };
  }, [f]);

  // Live cost preview from the same server code that prices the real shift.
  useEffect(() => {
    if (!f.siteId) return;
    const t = setTimeout(() => {
      api<Preview>(`/businesses/${id}/shifts/preview`, { method: 'POST', body }).then((p) => { setPreview(p); setPErr(''); }).catch((e) => { setPreview(null); setPErr(errText(e)); });
    }, 400);
    return () => clearTimeout(t);
  }, [body, id, f.siteId]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const toggle = (k: 'skills' | 'languages', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const s = await api(`/businesses/${id}/shifts`, { method: 'POST', body }); router.push(`/b/${id}/shifts/${s.id}`); }
    catch (e2) { setErr(errText(e2)); } finally { setBusy(false); }
  };
  const role = ref?.roles.find((r) => r.code === f.roleCode);

  if (ref && sites.length === 0) return <div className="panel">You need an approved site before posting. <a href={`/b/${id}/sites`}>Add a site</a>.</div>;
  return (
    <form onSubmit={submit}>
      <h2>Post a shift</h2>
      <div className="panel form-grid">
        <div><label htmlFor="site">Site</label><select id="site" value={f.siteId} onChange={set('siteId')}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label htmlFor="role">Role</label><select id="role" value={f.roleCode} onChange={(e) => setF({ ...f, roleCode: e.target.value, skills: [] })}>{ref?.roles.map((r) => <option key={r.code} value={r.code}>{r.name.en}</option>)}</select></div>
        <div style={{ gridColumn: '1 / -1' }}><label htmlFor="title">Title</label><input id="title" value={f.title} onChange={set('title')} placeholder="e.g. Parcel packing for sale week" required /></div>
        <div style={{ gridColumn: '1 / -1' }}><label htmlFor="desc">What the work involves</label><textarea id="desc" rows={3} value={f.description} onChange={set('description')} /></div>
        <div><label htmlFor="date">Date</label><input id="date" type="date" value={f.date} onChange={set('date')} required /></div>
        <div><label htmlFor="start">Start (IST)</label><input id="start" type="time" value={f.start} onChange={set('start')} required /></div>
        <div><label htmlFor="end">End (IST)</label><input id="end" type="time" value={f.end} onChange={set('end')} required /></div>
        <div><label htmlFor="brk">Unpaid break (min)</label><input id="brk" type="number" min={0} max={120} value={f.breakMinutes} onChange={set('breakMinutes')} /></div>
        <div><label htmlFor="hc">People needed</label><input id="hc" type="number" min={1} max={500} value={f.headcount} onChange={set('headcount')} required /></div>
        <div><label htmlFor="pt">Pay</label><select id="pt" value={f.payType} onChange={set('payType')}><option value="hourly">Per hour</option><option value="per_shift">Per shift</option></select></div>
        <div><label htmlFor="pay">Base pay (₹)</label><input id="pay" inputMode="decimal" value={f.pay} onChange={set('pay')} required /></div>
        <div><label htmlFor="meal">Meal allowance (₹)</label><input id="meal" inputMode="decimal" value={f.meal} onChange={set('meal')} /></div>
        <div><label htmlFor="travel">Travel allowance (₹)</label><input id="travel" inputMode="decimal" value={f.travel} onChange={set('travel')} /></div>
        <div><label htmlFor="dress">Dress code</label><input id="dress" value={f.dressCode} onChange={set('dressCode')} /></div>
        <div><label htmlFor="bring">What to bring</label><input id="bring" value={f.bringItems} onChange={set('bringItems')} /></div>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Requirements</h3>
        <p className="muted">Only job-related requirements. Filtering by religion, caste, gender or looks is not allowed.</p>
        <div className="field"><label>Skills</label><div className="chips">{(role?.skills ?? []).map((s) => (
          <button type="button" key={s} className={`chip ${f.skills.includes(s) ? 'on' : ''}`} onClick={() => toggle('skills', s)}>{ref?.skills.find((x) => x.code === s)?.name.en ?? s}</button>))}</div></div>
        <div className="field" style={{ marginTop: 10 }}><label>Speaks any of</label><div className="chips">{ref?.languages.map((l) => (
          <button type="button" key={l} className={`chip ${f.languages.includes(l) ? 'on' : ''}`} onClick={() => toggle('languages', l)}>{LANG_NAMES[l]}</button>))}</div></div>
        <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.twoWheeler} onChange={(e) => setF({ ...f, twoWheeler: e.target.checked })} /> Needs own two-wheeler</label>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Total cost</h3>
        {pErr && <p className="err">{pErr}</p>}
        {preview && (
          <>
            <table className="cost"><tbody>
              <tr><td>Worker pay ({f.headcount} × {rupees(preview.cost.perWorkerPayPaise)}, {(preview.cost.paidMinutes / 60).toFixed(2)} paid hours)</td><td>{rupees(preview.cost.workerPayTotalPaise)}</td></tr>
              <tr><td>Allowances</td><td>{rupees(preview.cost.allowancesTotalPaise)}</td></tr>
              <tr><td>ShiftKart fee ({preview.cost.feeBp / 100}% of worker pay)</td><td>{rupees(preview.cost.feePaise)}</td></tr>
              <tr><td>GST on fee ({preview.cost.gstBp / 100}%)</td><td>{rupees(preview.cost.gstOnFeePaise)}</td></tr>
              <tr className="total"><td>You fund now</td><td>{rupees(preview.cost.totalPaise)}</td></tr>
            </tbody></table>
            <p className="muted">Minimum base pay here: {rupees(preview.minHourlyPaise)}/hour ({preview.wageCategory.replace('_', '-')}). Allowances don&apos;t count toward it.</p>
            {preview.needsReview.length > 0 && <p className="note">This post will be checked by our team before it can go live ({preview.needsReview.join(', ').replaceAll('_', ' ')}).</p>}
          </>
        )}
      </div>
      <p><button disabled={busy || !preview}>Create shift</button></p>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><NewShift /></Shell>; }
