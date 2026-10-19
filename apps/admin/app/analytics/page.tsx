'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { api } from '../lib/api';

type Day = { date: string; fillRate: number | null; noShowRate: number | null; timeToFillMin: number | null; payoutDelayP50Min: number | null; disputeRate: number | null; fraudFlags: number | null };
type A = {
  days: number;
  kpis: { fillRate: number | null; noShowRate: number | null; medianTimeToFillMin: number | null; payoutDelayP50Min: number | null; payoutDelayP95Min: number | null; payoutsOver24h: number; disputeRate: number | null; fraudFlags: number };
  daily: Day[]; flagsByRule: { rule: string; count: number; open: number }[];
};

const mins = (m: number | null) => (m == null ? '—' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Sparkline: 2px line, 10% wash, end dot with a surface ring, crosshair + tooltip on hover. Gaps where there's no data. */
function Spark({ data, field, fmt }: { data: Day[]; field: keyof Day; fmt: (v: number | null) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 200, H = 44, P = 5;
  const vals = data.map((d) => (d[field] as number | null));
  const known = vals.filter((v): v is number => v != null);
  if (!known.length) return <div className="s">No data in this period</div>;
  const max = Math.max(...known, 1), min = Math.min(...known, 0);
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, data.length - 1);
  const y = (v: number) => H - P - ((v - min) * (H - 2 * P)) / (max - min || 1);
  // Runs of consecutive known values; a missing day breaks the line instead of drawing through zero.
  const runs: [number, number][][] = [];
  let cur: [number, number][] = [];
  vals.forEach((v, i) => { if (v == null) { if (cur.length) runs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) runs.push(cur);
  const line = (r: [number, number][]) => r.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  const area = (r: [number, number][]) => `${line(r)}L${r[r.length - 1]![0].toFixed(1)},${H - P}L${r[0]![0].toFixed(1)},${H - P}Z`;
  const lastI = vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop()!;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Daily trend, last value ${fmt(vals[lastI] ?? null)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const i = Math.round(((e.clientX - r.left) / r.width) * (W - 2 * P) / ((W - 2 * P) / Math.max(1, data.length - 1))); setHover(Math.max(0, Math.min(data.length - 1, i))); }}>
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--grid)" strokeWidth={1} />
        {runs.map((r, i) => <path key={`a${i}`} d={area(r)} fill="var(--series-1-wash)" />)}
        {runs.map((r, i) => <path key={i} d={line(r)} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        <circle cx={x(lastI)} cy={y(vals[lastI]!)} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={P} y2={H - P} stroke="var(--muted)" strokeWidth={1} />}
        {hover != null && vals[hover] != null && <circle cx={x(hover)} cy={y(vals[hover]!)} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />}
      </svg>
      {hover != null && <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: 0 }}>{dayLabel(data[hover]!.date)}: {fmt(vals[hover] ?? null)}</div>}
    </div>
  );
}

/** Horizontal bars, ≤24px thick, 4px rounded end, value at the tip, tooltip with open count. */
function FlagBars({ rows }: { rows: A['flagsByRule'] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return <p className="muted">No fraud flags in this period.</p>;
  const max = Math.max(...rows.map((r) => r.count));
  const LABEL = 210, W = 640, BAR = 20, GAP = 10;
  return (
    <div style={{ position: 'relative', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${rows.length * (BAR + GAP)}`} width="100%" role="img" aria-label="Fraud flags raised, by rule">
        {rows.map((r, i) => {
          const w = Math.max(4, ((W - LABEL - 50) * r.count) / max);
          const y0 = i * (BAR + GAP);
          return (
            <g key={r.rule} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={0} y={y0} width={W} height={BAR + GAP} fill="transparent" />
              <text x={LABEL - 8} y={y0 + BAR / 2 + 4} textAnchor="end" fontSize={12} fill="var(--text)">{r.rule.replaceAll('_', ' ')}</text>
              <path d={`M${LABEL},${y0}h${w - 4}a4,4 0 0 1 4,4v${BAR - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z`} fill="var(--series-1)" opacity={hover == null || hover === i ? 1 : 0.55} />
              <text x={LABEL + w + 6} y={y0 + BAR / 2 + 4} fontSize={12} fill="var(--muted)">{r.count}</text>
            </g>
          );
        })}
      </svg>
      {hover != null && <div className="tip" style={{ left: '50%', top: hover * (BAR + GAP) * 0.9 + 10 }}>{rows[hover]!.rule.replaceAll('_', ' ')}: {rows[hover]!.count} raised, {rows[hover]!.open} still open</div>}
    </div>
  );
}

function Analytics() {
  const [days, setDays] = useState(30);
  const [city, setCity] = useState('');
  const [a, setA] = useState<A | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => { api<A>(`/admin/analytics?days=${days}${city ? `&city=${city}` : ''}`).then(setA).catch(() => {}); }, [days, city]);
  const tiles = useMemo(() => a ? [
    { k: 'Fill rate', v: pct(a.kpis.fillRate), s: 'booked slots ÷ posted slots', field: 'fillRate' as const, fmt: pct },
    { k: 'No-show rate', v: pct(a.kpis.noShowRate), s: 'of workers due on site', field: 'noShowRate' as const, fmt: pct },
    { k: 'Time to fill (median)', v: mins(a.kpis.medianTimeToFillMin), s: 'from publishing to the last slot taken', field: 'timeToFillMin' as const, fmt: mins },
    { k: 'Payout delay (median)', v: mins(a.kpis.payoutDelayP50Min), s: `p95 ${mins(a.kpis.payoutDelayP95Min)} · ${a.kpis.payoutsOver24h} over 24 h`, field: 'payoutDelayP50Min' as const, fmt: mins },
    { k: 'Dispute rate', v: pct(a.kpis.disputeRate), s: 'of timesheets', field: 'disputeRate' as const, fmt: pct },
    { k: 'Fraud flags raised', v: String(a.kpis.fraudFlags), s: 'all rules', field: 'fraudFlags' as const, fmt: (v: number | null) => String(v ?? 0) },
  ] : [], [a]);
  return (
    <>
      <h2>Operations dashboard</h2>
      <div className="panel row">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
        <select value={city} onChange={(e) => setCity(e.target.value)}><option value="">All cities</option><option value="BLR">Bengaluru</option><option value="MYS">Mysuru</option><option value="MLR">Mangaluru</option><option value="HBL">Hubballi-Dharwad</option></select>
        <button className="secondary" onClick={() => setTable(!table)}>{table ? 'Show charts' : 'Show as table'}</button>
        <span className="muted">Aggregates only, no personal data. Days are IST.</span>
      </div>
      {!a ? <p className="muted">Loading…</p> : table ? (
        <div className="panel"><table>
          <thead><tr><th>Day</th><th>Fill rate</th><th>No-show</th><th>Time to fill</th><th>Payout delay</th><th>Disputes</th><th>Flags</th></tr></thead>
          <tbody>{a.daily.slice().reverse().map((d) => <tr key={d.date}><td>{dayLabel(d.date)}</td><td>{pct(d.fillRate)}</td><td>{pct(d.noShowRate)}</td><td>{mins(d.timeToFillMin)}</td><td>{mins(d.payoutDelayP50Min)}</td><td>{pct(d.disputeRate)}</td><td>{d.fraudFlags}</td></tr>)}</tbody>
        </table></div>
      ) : (
        <>
          <div className="tiles">{tiles.map((t) => (
            <div className="tile" key={t.k}><div className="k">{t.k}</div><div className="v">{t.v}</div><Spark data={a.daily} field={t.field} fmt={t.fmt} /><div className="s">{t.s}</div></div>
          ))}</div>
          <div className="panel"><h3 style={{ marginTop: 0 }}>Fraud flags by rule</h3><FlagBars rows={a.flagsByRule} /></div>
        </>
      )}
    </>
  );
}

export default function Page() { return <Shell><Analytics /></Shell>; }
