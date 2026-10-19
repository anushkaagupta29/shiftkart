import { useState } from 'react';
import { ApiError } from './api';
import type { Lang, T as Strings } from './i18n';

export type Me = {
  firstName: string | null; verificationStatus: string; kycRejectReason: string | null;
  steps: { identity: string; selfie: string; payout: string; profile: string };
  profile: { languages: string[]; skills: string[]; travelRadiusKm: number; hasTwoWheeler: boolean; homeCity: string | null };
};
export type Shift = {
  id: string; title: string; description: string; businessName: string; siteName: string; address: string; distanceKm?: number;
  startsAt: string; endsAt: string; breakMinutes: number; slotsLeft: number; headcount: number; dressCode: string; bringItems: string;
  pay: { type: string; hourlyPaise: number; totalPaise: number; mealAllowancePaise: number; travelAllowancePaise: number; takeHomePaise: number };
  eligible: boolean; missing: string[]; myWaitlist: { id: string; status: string } | null;
  isNight?: boolean; transportProvided?: boolean; businessId?: string; businessRating?: { score: number | null; count: number } | null;
};
export type Booking = { bookingId: string; bookingStatus: string; shift: Shift };
export type Offer = { id: string; status: string; expiresAt: string | null; shiftId: string; title: string; startsAt: string };
export type Ref = { skills: { code: string; name: Record<string, string> }[]; cities: { code: string; name: string }[] };

export type Route =
  | { name: 'lang' } | { name: 'phone' } | { name: 'code'; phone: string } | { name: 'consent'; phone: string; code: string }
  | { name: 'setup' } | { name: 'digilocker'; sessionId: string } | { name: 'selfie' } | { name: 'payout' } | { name: 'profile' }
  | { name: 'home'; tab: Tab } | { name: 'shift'; id: string }
  | { name: 'booking'; bookingId: string; shiftId: string } | { name: 'payslip'; id: string }
  | { name: 'chat'; bookingId: string; shiftId: string; title: string } | { name: 'safety'; bookingId?: string } | { name: 'me' } | { name: 'dispute'; id: string };

export type Tab = 'shifts' | 'mine' | 'offers' | 'earnings';

export const showError = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
export type P = { t: Strings; lang: Lang; go: (r: Route) => void; setError: (s: string) => void; refreshMe: () => Promise<Me>; me: Me | null; afterLogin: () => Promise<void> };

export function useBusy(setError: (s: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(showError(e)); } finally { setBusy(false); }
  };
  return { busy, run };
}

