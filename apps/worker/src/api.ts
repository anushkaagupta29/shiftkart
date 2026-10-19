import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Android emulator reaches the laptop at 10.0.2.2; web and iOS simulator at localhost.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

// Tokens: Android keystore via SecureStore. On web (used for testing only) they live in sessionStorage.
const store = {
  async get(k: string) {
    if (Platform.OS === 'web') { try { return sessionStorage.getItem(k); } catch { return null; } }
    return SecureStore.getItemAsync(k);
  },
  async set(k: string, v: string | null) {
    if (Platform.OS === 'web') { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } return; }
    if (v === null) await SecureStore.deleteItemAsync(k); else await SecureStore.setItemAsync(k, v);
  },
};

let access: string | null = null;

export async function loadSession(): Promise<boolean> {
  access = await store.get('sk_at');
  return Boolean(access || (await store.get('sk_rt')));
}

export async function saveTokens(t: { accessToken: string; refreshToken: string }) {
  access = t.accessToken;
  await store.set('sk_at', t.accessToken);
  await store.set('sk_rt', t.refreshToken);
}

export async function clearSession() {
  access = null;
  await store.set('sk_at', null);
  await store.set('sk_rt', null);
}

export async function deviceId(): Promise<string> {
  let id = await store.get('sk_device');
  if (!id) {
    id = `${Platform.OS}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    await store.set('sk_device', id);
  }
  return id;
}

async function refresh(): Promise<boolean> {
  const rt = await store.get('sk_rt');
  if (!rt) return false;
  const r = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  if (!r.ok) { await clearSession(); return false; }
  await saveTokens(await r.json());
  return true;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const go = () => fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(access ? { authorization: `Bearer ${access}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let res: Response;
  try { res = await go(); } catch { throw new ApiError(0, 'offline', 'No internet connection.'); }
  if (res.status === 401 && !path.startsWith('/auth/') && (await refresh())) res = await go();
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong.');
  return data as T;
}

export const rupees = (paise: number) => {
  const r = Math.floor(paise / 100).toString(); const p = paise % 100;
  const last3 = r.slice(-3); const rest = r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `₹${rest ? rest + ',' : ''}${last3}${p ? '.' + String(p).padStart(2, '0') : ''}`;
};

export const istTime = (iso: string, lang: string) =>
  new Date(iso).toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
export const istDay = (iso: string, lang: string) =>
  new Date(iso).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

// Offline queue for check-in/out: if there's no network, the scan is saved with the time it happened
// and sent later. The server trusts the gate code's time, not the phone's clock (SYS-08).
export type PendingClock = { bookingId: string; kind: 'check-in' | 'check-out'; body: Record<string, unknown> };

export async function loadPending(): Promise<PendingClock[]> {
  try { return JSON.parse((await store.get('sk_pending')) ?? '[]'); } catch { return []; }
}
export async function savePending(list: PendingClock[]) {
  await store.set('sk_pending', list.length ? JSON.stringify(list) : null);
}
export async function flushPending(): Promise<number> {
  const list = await loadPending();
  const left: PendingClock[] = [];
  let sent = 0;
  for (const p of list) {
    try { await api(`/worker/bookings/${p.bookingId}/${p.kind}`, { method: 'POST', body: p.body }); sent += 1; }
    catch (e) { if (e instanceof ApiError && e.code === 'offline') left.push(p); }
  }
  await savePending(left);
  return sent;
}
