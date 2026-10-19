'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

async function raw(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }) {
  return fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include', // HttpOnly session cookies; the page never sees a token
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Calls the API; on an expired session it refreshes once (rotating cookie) and retries. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const r = await raw('/auth/refresh', { method: 'POST', body: {} });
    if (r.ok) res = await raw(path, init);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.issues);
  }
  return data as T;
}

export const errText = (e: unknown) =>
  e instanceof ApiError ? (e.issues?.length ? `${e.message} ${e.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` : e.message) : 'Could not reach ShiftKart. Check your connection.';

export const rupees = (paise: number) => {
  const neg = paise < 0; const abs = Math.abs(paise);
  const r = Math.floor(abs / 100).toString(); const p = (abs % 100).toString().padStart(2, '0');
  const last3 = r.slice(-3); const rest = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₹${rest ? rest + ',' : ''}${last3}.${p}`;
};

/** Parses "123.45" (rupees) into integer paise without floating point. */
export function toPaise(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export const ist = (iso?: string | null, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) =>
  iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts }) : '—';

/** "2026-11-02" + "09:30" in IST → ISO UTC string. */
export function istToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000).toISOString();
}
