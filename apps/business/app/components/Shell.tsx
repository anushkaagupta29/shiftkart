'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

export type Me = { id: string; kind: string; phone: string };

export function Shell({ children, businessId }: { children: React.ReactNode; businessId?: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    api<Me>('/me').then((m) => {
      if (m.kind !== 'business') router.replace('/login?wrong=1');
      else setMe(m);
    }).catch((e) => { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.replace('/login'); });
  }, [router]);
  if (!me) return <div className="page muted">Loading…</div>;

  const links = businessId
    ? [[`/b/${businessId}`, 'Overview'], [`/b/${businessId}/shifts`, 'Shifts'], [`/b/${businessId}/sites`, 'Sites'], [`/b/${businessId}/team`, 'Team']]
    : [];
  const logout = async () => { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); router.replace('/login'); };
  return (
    <>
      <header className="top">
        <Link href="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>ShiftKart for Business</Link>
        <nav>{links.map(([href, label]) => <Link key={href} href={href!} className={path === href ? 'active' : ''}>{label}</Link>)}</nav>
        <span className="muted" style={{ marginLeft: 'auto' }}>{me.phone}</span>
        <button className="secondary" onClick={logout}>Log out</button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
