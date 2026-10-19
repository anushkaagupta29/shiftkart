'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Shell } from '../../../components/Shell';
import { api, errText } from '../../../lib/api';

type Site = { id: string; name: string; address: string; cityCode: string; geofenceM: number; status: string; statusReason: string | null; lat: number; lng: number };
type City = { code: string; name: string; lat: number; lng: number };

function Sites() {
  const { id } = useParams<{ id: string }>();
  const [sites, setSites] = useState<Site[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [f, setF] = useState({ name: '', address: '', cityCode: 'BLR', lat: '', lng: '', geofenceM: '150' });
  const [err, setErr] = useState('');
  const load = () => api<Site[]>(`/businesses/${id}/sites`).then(setSites).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); api('/reference').then((r) => setCities(r.cities)); }, [id]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const locate = () => navigator.geolocation?.getCurrentPosition(
    (p) => setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) })),
    () => setErr('Could not get your location. Enter the coordinates from Google Maps instead.'),
  );
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      await api(`/businesses/${id}/sites`, { method: 'POST', body: { name: f.name, address: f.address, cityCode: f.cityCode, lat: Number(f.lat), lng: Number(f.lng), geofenceM: Number(f.geofenceM) } });
      setF({ ...f, name: '', address: '', lat: '', lng: '' }); load();
    } catch (e2) { setErr(errText(e2)); }
  };
  const city = cities.find((c) => c.code === f.cityCode);

  return (
    <>
      <h2>Work sites</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Address</th><th>Check-in radius</th><th>Status</th></tr></thead>
          <tbody>{sites.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td>{s.address}<br /><a className="muted" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${s.lat}/${s.lng}`}>View on map</a></td>
              <td>{s.geofenceM} m</td><td><span className="pill">{s.status}</span>{s.statusReason && <div className="muted">{s.statusReason}</div>}</td></tr>
          ))}</tbody>
        </table>
        {sites.length === 0 && <p className="muted">No sites yet.</p>}
      </div>
      <form className="panel" onSubmit={add}>
        <h3 style={{ marginTop: 0 }}>Add a site</h3>
        <p className="muted">Workers check in by being inside this radius and scanning your supervisor&apos;s QR code. Every new site is checked by our team.</p>
        <div className="form-grid">
          <div><label htmlFor="sn">Site name</label><input id="sn" value={f.name} onChange={set('name')} required /></div>
          <div><label htmlFor="city">City</label><select id="city" value={f.cityCode} onChange={set('cityCode')}>{cities.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
          <div style={{ gridColumn: '1 / -1' }}><label htmlFor="addr">Full address</label><textarea id="addr" rows={2} value={f.address} onChange={set('address')} required /></div>
          <div><label htmlFor="lat">Latitude</label><input id="lat" value={f.lat} onChange={set('lat')} placeholder={city ? String(city.lat) : ''} required /></div>
          <div><label htmlFor="lng">Longitude</label><input id="lng" value={f.lng} onChange={set('lng')} placeholder={city ? String(city.lng) : ''} required /></div>
          <div><label htmlFor="gf">Check-in radius (m)</label><input id="gf" type="number" min={50} max={2000} value={f.geofenceM} onChange={set('geofenceM')} /></div>
        </div>
        <p className="row"><button type="button" className="secondary" onClick={locate}>Use my current location</button><button>Add site</button></p>
        {err && <p className="err">{err}</p>}
      </form>
    </>
  );
}

export default function Page() { const { id } = useParams<{ id: string }>(); return <Shell businessId={id}><Sites /></Shell>; }
