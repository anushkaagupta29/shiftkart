'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

export type Staff = { id: string; email: string; name: string; roles: string[] };
const StaffCtx = createContext<Staff | null>(null);
export const useStaff = () => useContext(StaffCtx)!;
export const hasRole = (s: Staff, roles: string[]) => s.roles.some((r) => roles.includes(r));

// Mirrors ADMIN_ACCESS in apps/api/src/routes/admin.ts. Only hides links: the API enforces access.
const NAV: { href: string; label: string; roles?: string[]; section?: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/businesses', label: 'Business verification', roles: ['ops_verifier', 'ops_support', 'compliance'], section: 'Queues' },
  { href: '/shift-review', label: 'Shift review', roles: ['ops_verifier', 'compliance'] },
  { href: '/flags', label: 'Fraud flags', roles: ['ops_verifier', 'ops_safety', 'ops_disputes', 'compliance'] },
  { href: '/safety', label: 'Safety desk', roles: ['ops_safety'] },
  { href: '/cases', label: 'Dispute cases', roles: ['ops_disputes'] },
  { href: '/disputes', label: 'Timesheet disputes', roles: ['ops_disputes'] },
  { href: '/appeals', label: 'Strike appeals', roles: ['ops_disputes', 'ops_support'] },
  { href: '/chat-reports', label: 'Chat reports', roles: ['ops_safety', 'ops_support', 'ops_disputes'] },
  { href: '/payouts', label: 'Payouts', roles: ['finance', 'ops_support'] },
  { href: '/users', label: 'Users', roles: ['ops_support', 'ops_verifier', 'ops_disputes', 'ops_safety', 'compliance'], section: 'Records' },
  { href: '/payments', label: 'Shift funding', roles: ['finance'] },
  { href: '/reconciliation', label: 'Reconciliation', roles: ['finance'] },
  { href: '/wage-rates', label: 'Minimum wages', roles: ['compliance', 'finance', 'ops_verifier'], section: 'Rules' },
  { href: '/audit', label: 'Audit log', roles: ['compliance', 'super_admin'], section: 'Oversight' },
  { href: '/reviewers', label: 'Verifier oversight', roles: ['compliance', 'super_admin'] },
  { href: '/policy', label: 'Policy values', roles: ['compliance', 'super_admin', 'finance'] },
  { href: '/staff', label: 'Staff', roles: ['super_admin'] },
  { href: '/dev/outbox', label: 'SMS outbox (dev)', section: 'Developer' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    api<Staff>('/admin/me').then(setStaff).catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
    });
  }, [router]);

  if (!staff) return <div className="main muted">Loading…</div>;

  const logout = async () => {
    await api('/admin/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    router.replace('/login');
  };

  return (
    <StaffCtx.Provider value={staff}>
      <div className="layout">
        <aside className="side">
          <h1>ShiftKart Admin</h1>
          <div className="who">{staff.email}<br />{staff.roles.join(', ')}</div>
          <nav>
            {NAV.filter((n) => !n.roles || hasRole(staff, n.roles)).map((n) => (
              <div key={n.href}>
                {n.section && <div className="section">{n.section}</div>}
                <Link href={n.href} className={path === n.href ? 'active' : ''}>{n.label}</Link>
              </div>
            ))}
          </nav>
          <p><button className="secondary" onClick={logout}>Log out</button></p>
        </aside>
        <main className="main">{children}</main>
      </div>
    </StaffCtx.Provider>
  );
}
