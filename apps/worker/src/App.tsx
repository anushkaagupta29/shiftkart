import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import { ApiError, api, clearSession, deviceId, flushPending, istDay, istTime, loadPending, loadSession, rupees, saveTokens } from './api';
import { STRINGS, type Lang, type T as Strings } from './i18n';
import { showError, useBusy, type Booking, type Me, type Offer, type P, type Ref, type Route, type Shift, type Tab } from './common';
import { BookingScreen, EarningsTab, PayslipScreen, PendingConfirmations } from './ShiftDay';
import { Banner, Big, Card, Chip, Field, Screen, T, useColors } from './ui';

const LANG_NAMES: Record<string, string> = { hi: 'हिंदी', en: 'English', kn: 'ಕನ್ನಡ', ta: 'தமிழ்', te: 'తెలుగు', mr: 'मराठी', bn: 'বাংলা', ur: 'اردو', ml: 'മലയാളം' };

export default function App() {
  const [lang, setLang] = useState<Lang>('hi');
  const [route, setRoute] = useState<Route>({ name: 'lang' });
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const t = STRINGS[lang];
  const c = useColors();

  const go = useCallback((r: Route) => { setError(''); setRoute(r); }, []);
  const refreshMe = useCallback(async () => {
    const m = await api<Me>('/worker/me');
    setMe(m);
    return m;
  }, []);
  const afterLogin = useCallback(async () => {
    const m = await refreshMe();
    go(m.verificationStatus === 'verified' ? { name: 'home', tab: 'shifts' } : { name: 'setup' });
  }, [refreshMe, go]);

  useEffect(() => {
    loadSession().then((has) => { if (has) afterLogin().catch(() => {}); });
  }, [afterLogin]);

  const props = { t, lang, go, setError, refreshMe, me, afterLogin };
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style="auto" />
      {error ? <View style={{ paddingHorizontal: 16, paddingTop: 8 }}><Banner kind="error" text={error} /></View> : null}
      {route.name === 'lang' && <LangScreen onPick={(l) => { setLang(l); go({ name: 'phone' }); }} />}
      {route.name === 'phone' && <PhoneScreen {...props} />}
      {route.name === 'code' && <CodeScreen {...props} phone={route.phone} />}
      {route.name === 'consent' && <ConsentScreen {...props} phone={route.phone} code={route.code} />}
      {route.name === 'setup' && <SetupScreen {...props} />}
      {route.name === 'digilocker' && <DigiLockerScreen {...props} sessionId={route.sessionId} />}
      {route.name === 'selfie' && <SelfieScreen {...props} />}
      {route.name === 'payout' && <PayoutScreen {...props} />}
      {route.name === 'profile' && <ProfileScreen {...props} />}
      {route.name === 'home' && <HomeScreen {...props} tab={route.tab} />}
      {route.name === 'shift' && <ShiftScreen {...props} id={route.id} />}
      {route.name === 'booking' && <BookingScreen {...props} bookingId={route.bookingId} shiftId={route.shiftId} />}
      {route.name === 'payslip' && <PayslipScreen {...props} id={route.id} />}
    </View>
  );
}

// ------------------------------------------------------------------ login

function LangScreen({ onPick }: { onPick: (l: Lang) => void }) {
  return (
    <Screen title="भाषा / Language">
      <Big testID="lang-hi" label="हिंदी" onPress={() => onPick('hi')} />
      <Big testID="lang-en" label="English" onPress={() => onPick('en')} kind="secondary" />
      <T muted>ಕನ್ನಡ: coming soon</T>
      <Banner text={STRINGS.hi.noFees} />
    </Screen>
  );
}

function PhoneScreen({ t, go, setError }: P) {
  const [phone, setPhone] = useState('');
  const { busy, run } = useBusy(setError);
  return (
    <Screen title={t.phoneTitle} onBack={() => go({ name: 'lang' })} backLabel={t.back}>
      <Field testID="phone" label="📱 +91" keyboardType="phone-pad" value={phone} onChangeText={setPhone} maxLength={14} autoFocus />
      <Big testID="send-code" label={t.sendCode} busy={busy} disabled={phone.replace(/\D/g, '').length < 10}
        onPress={() => run(async () => { await api('/auth/otp/request', { method: 'POST', body: { phone } }); go({ name: 'code', phone }); })} />
      <Banner text={t.noFees} />
    </Screen>
  );
}

function CodeScreen({ t, go, setError, afterLogin, phone }: P & { phone: string }) {
  const [code, setCode] = useState('');
  const [dev, setDev] = useState('');
  const { busy, run } = useBusy(setError);
  const verify = () => run(async () => {
    try {
      const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, code, deviceId: await deviceId(), platform: Platform.OS === 'web' ? 'web' : 'android' } });
      await saveTokens(r);
      await afterLogin();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'signup_required') { go({ name: 'consent', phone, code }); return; }
      throw e;
    }
  });
  return (
    <Screen title={t.codeTitle} onBack={() => go({ name: 'phone' })} backLabel={t.changeNumber}>
      <Field testID="code" label="🔢" keyboardType="number-pad" value={code} onChangeText={setCode} maxLength={6} autoFocus />
      <Big testID="verify" label={t.verify} busy={busy} disabled={code.length !== 6} onPress={verify} />
      {__DEV__ && (
        <Big testID="dev-code" kind="secondary" label={dev || t.devShowCode} onPress={async () => {
          const r = await api<{ body: string }[]>('/dev/outbox', { method: 'POST', body: { phone } }).catch(() => []);
          const found = r[0]?.body.match(/\d{6}/)?.[0];
          if (found) { setDev(found); setCode(found); }
        }} />
      )}
    </Screen>
  );
}

function ConsentScreen({ t, lang, go, setError, afterLogin, phone, code }: P & { phone: string; code: string }) {
  const [loc, setLoc] = useState(true);
  const [face, setFace] = useState(true);
  const { busy, run } = useBusy(setError);
  return (
    <Screen title={t.consentTitle} onBack={() => go({ name: 'phone' })} backLabel={t.back}>
      <Card><T>✅ {t.consentAccount}</T></Card>
      <Chip testID="consent-location" label={t.consentLocation} on={loc} onPress={() => setLoc(!loc)} />
      <Chip testID="consent-face" label={t.consentFace} on={face} onPress={() => setFace(!face)} />
      <T muted size={14}>{t.consentDraft}</T>
      <Big testID="agree" label={t.agree} busy={busy} onPress={() => run(async () => {
        const consents = ['account', 'notifications', ...(loc ? ['location_at_shift'] : []), ...(face ? ['face_verification'] : [])];
        const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, code, deviceId: await deviceId(), platform: Platform.OS === 'web' ? 'web' : 'android', signup: { kind: 'worker', lang, consents } } });
        await saveTokens(r);
        await afterLogin();
      })} />
    </Screen>
  );
}

// ------------------------------------------------------------------ onboarding

function SetupScreen({ t, go, setError, refreshMe, me }: P) {
  const { busy, run } = useBusy(setError);
  // Once on mount: refresh the checklist (e.g. after ops clear a review).
  useEffect(() => { refreshMe().then((m) => { if (m.verificationStatus === 'verified') go({ name: 'home', tab: 'shifts' }); }).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me) return <Screen><T>…</T></Screen>;
  const s = me.steps;
  const rows: [string, string, string, () => void][] = [
    ['identity', '🪪', t.stepIdentity, () => run(async () => { const r = await api('/worker/kyc/start', { method: 'POST' }); go({ name: 'digilocker', sessionId: r.sessionId }); })],
    ['selfie', '🤳', t.stepSelfie, () => go({ name: 'selfie' })],
    ['payout', '🏦', t.stepPayout, () => go({ name: 'payout' })],
    ['profile', '🧰', t.stepProfile, () => go({ name: 'profile' })],
  ];
  const state = (k: string) => (k === 'identity' ? s.identity : k === 'selfie' ? s.selfie : k === 'payout' ? s.payout : s.profile);
  const isDone = (v: string) => v === 'done' || v === 'verified';
  const enabled = (k: string) => k === 'identity' || k === 'profile' || s.identity === 'verified';
  return (
    <Screen title={t.setupTitle}>
      {me.verificationStatus === 'review' && <Banner text={t.underReview} />}
      {me.verificationStatus === 'rejected' && <Banner kind="error" text={me.kycRejectReason === 'underage' ? 'You must be 18 or older. / आपकी उम्र 18 साल या उससे ज़्यादा होनी चाहिए।' : t.underReview} />}
      {rows.map(([k, icon, label, onPress]) => (
        <Card key={k} testID={`step-${k}`} onPress={isDone(state(k)) || !enabled(k) || busy || me.verificationStatus === 'rejected' ? undefined : onPress}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T size={20} bold>{icon}  {label}</T>
            <T size={18} color={isDone(state(k)) ? '#0b6e4f' : undefined}>{isDone(state(k)) ? `✓ ${t.done}` : state(k) === 'review' ? t.inReview : enabled(k) ? `${t.start} →` : '🔒'}</T>
          </View>
        </Card>
      ))}
      <Banner text={t.noFees} />
      <Big kind="secondary" label={t.logout} onPress={async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); await clearSession(); go({ name: 'lang' }); }} />
    </Screen>
  );
}

/** Stand-in for DigiLocker's consent page, only in this test build. */
function DigiLockerScreen({ t, go, setError, refreshMe, sessionId }: P & { sessionId: string }) {
  const { busy, run } = useBusy(setError);
  const approve = (persona: { name: string; dob: string; personId?: string }) => run(async () => {
    const personId = persona.personId ?? `person-${Math.random().toString(36).slice(2)}`;
    await api(`/mock/digilocker/${sessionId}/approve`, { method: 'POST', body: { ...persona, personId } });
    await api('/worker/kyc/complete', { method: 'POST', body: { sessionId } });
    await refreshMe();
    go({ name: 'setup' });
  });
  const minorYear = new Date().getFullYear() - 16;
  return (
    <Screen title={t.dlTitle} onBack={() => go({ name: 'setup' })} backLabel={t.back}>
      <T muted>{t.dlNote}</T>
      <Big testID="dl-adult" label="Ravi Kumar, 1998" busy={busy} onPress={() => approve({ name: 'Ravi Kumar', dob: '1998-05-14' })} />
      <Big testID="dl-adult2" kind="secondary" label="Meena Devi, 1991" busy={busy} onPress={() => approve({ name: 'Meena Devi', dob: '1991-11-02' })} />
      <Big testID="dl-minor" kind="secondary" label={`Test: under 18 (${minorYear})`} busy={busy} onPress={async () => { await approve({ name: 'Young Person', dob: `${minorYear}-03-01` }); }} />
    </Screen>
  );
}

function SelfieScreen({ t, go, setError, refreshMe }: P) {
  const { busy, run } = useBusy(setError);
  const take = (who: 'self' | 'other' | 'spoof') => run(async () => {
    // The mock KYC face is tied to the identity chosen on the DigiLocker screen; the server knows it.
    // "self" re-uses that identity; the test buttons try someone else, or a photo held up to the camera.
    const kycFace = await api('/dev/my-face').catch(() => null);
    await api('/worker/selfie', { method: 'POST', body: { mockPersonId: who === 'other' ? 'someone-else' : kycFace?.personId ?? 'unknown', mockSpoof: who === 'spoof' } });
    await refreshMe();
    go({ name: 'setup' });
  });
  return (
    <Screen title={t.selfieTitle} onBack={() => go({ name: 'setup' })} backLabel={t.back}>
      <Card><T size={64} style={{ textAlign: 'center' }}>🤳</T><T muted>{t.selfieNote}</T></Card>
      <Big testID="selfie-take" label={t.takeSelfie} icon="📸" busy={busy} onPress={() => take('self')} />
      {__DEV__ && <Big testID="selfie-other" kind="secondary" label={t.selfieOther} busy={busy} onPress={() => take('other')} />}
      {__DEV__ && <Big testID="selfie-spoof" kind="secondary" label={t.selfieSpoof} busy={busy} onPress={() => take('spoof')} />}
    </Screen>
  );
}

function PayoutScreen({ t, go, setError, refreshMe }: P) {
  const [mode, setMode] = useState<'upi' | 'bank'>('upi');
  const [vpa, setVpa] = useState('');
  const [acct, setAcct] = useState('');
  const [ifsc, setIfsc] = useState('');
  const { busy, run } = useBusy(setError);
  return (
    <Screen title={t.upiTitle} onBack={() => go({ name: 'setup' })} backLabel={t.back}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <Chip label={t.upi} on={mode === 'upi'} onPress={() => setMode('upi')} />
        <Chip label={t.bank} on={mode === 'bank'} onPress={() => setMode('bank')} />
      </View>
      {mode === 'upi'
        ? <Field testID="vpa" label={t.upi} value={vpa} onChangeText={setVpa} autoCapitalize="none" placeholder="name@okaxis" />
        : <><Field label={t.accountNo} value={acct} onChangeText={setAcct} keyboardType="number-pad" /><Field label={t.ifsc} value={ifsc} onChangeText={(v) => setIfsc(v.toUpperCase())} autoCapitalize="characters" /></>}
      <T muted>{t.upiNote}</T>
      <Big testID="save-payout" label={t.save} busy={busy} onPress={() => run(async () => {
        await api('/worker/payout-method', { method: 'POST', body: mode === 'upi' ? { type: 'upi', vpa } : { type: 'bank', accountNo: acct, ifsc } });
        await refreshMe();
        go({ name: 'setup' });
      })} />
    </Screen>
  );
}

function ProfileScreen({ t, lang, go, setError, refreshMe, me }: P) {
  const [ref, setRef] = useState<Ref | null>(null);
  const [langs, setLangs] = useState<string[]>(me?.profile.languages.length ? me.profile.languages : [lang]);
  const [skills, setSkills] = useState<string[]>(me?.profile.skills ?? []);
  const [radius, setRadius] = useState(me?.profile.travelRadiusKm ?? 10);
  const [twoW, setTwoW] = useState(me?.profile.hasTwoWheeler ?? false);
  const [city, setCity] = useState(me?.profile.homeCity ?? 'BLR');
  const { busy, run } = useBusy(setError);
  useEffect(() => { api<Ref>('/reference').then(setRef).catch(() => {}); }, []);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Screen title={t.profileTitle} onBack={() => go(me?.verificationStatus === 'verified' ? { name: 'home', tab: 'shifts' } : { name: 'setup' })} backLabel={t.back}>
      <T bold>{t.languages}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{['hi', 'kn', 'en', 'ta', 'te', 'ur'].map((l) => <Chip key={l} testID={`lang-${l}`} label={LANG_NAMES[l]!} on={langs.includes(l)} onPress={() => toggle(langs, setLangs, l)} />)}</View>
      <T bold style={{ marginTop: 12 }}>{t.skills}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{ref?.skills.map((s) => <Chip key={s.code} testID={`skill-${s.code}`} label={s.name[lang] ?? s.name.en!} on={skills.includes(s.code)} onPress={() => toggle(skills, setSkills, s.code)} />)}</View>
      <T bold style={{ marginTop: 12 }}>{t.city}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{ref?.cities.map((cc) => <Chip key={cc.code} label={cc.name} on={city === cc.code} onPress={() => setCity(cc.code)} />)}</View>
      <T bold style={{ marginTop: 12 }}>{t.radius}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{[5, 10, 20, 30].map((r) => <Chip key={r} label={`${r} ${t.km}`} on={radius === r} onPress={() => setRadius(r)} />)}</View>
      <Chip testID="two-wheeler" label={`🛵 ${t.twoWheeler}`} on={twoW} onPress={() => setTwoW(!twoW)} />
      <Big testID="save-profile" label={t.save} busy={busy} disabled={!langs.length || !skills.length} onPress={() => run(async () => {
        await api('/worker/profile', { method: 'PUT', body: { languages: langs, skills, travelRadiusKm: radius, hasTwoWheeler: twoW, homeCity: city } });
        const m = await refreshMe();
        go(m.verificationStatus === 'verified' ? { name: 'home', tab: 'shifts' } : { name: 'setup' });
      })} />
    </Screen>
  );
}

// ------------------------------------------------------------------ shifts

function PayLine({ s, t }: { s: Shift; t: Strings }) {
  const extras = [s.pay.mealAllowancePaise ? `+ ${rupees(s.pay.mealAllowancePaise)} ${t.meal}` : '', s.pay.travelAllowancePaise ? `+ ${rupees(s.pay.travelAllowancePaise)} ${t.travel}` : ''].filter(Boolean).join('  ');
  return (
    <View>
      <T size={30} bold color="#0b6e4f">{rupees(s.pay.takeHomePaise)}</T>
      <T muted>{rupees(s.pay.hourlyPaise)}{t.perHour}{extras ? `  ·  ${extras}` : ''}</T>
    </View>
  );
}

function HomeScreen(props: P & { tab: Tab }) {
  const { t, lang, go, setError, tab } = props;
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  const [saved, setSaved] = useState(0);
  const { busy, run } = useBusy(setError);
  const load = useCallback(() => run(async () => {
    const [f, b, o] = await Promise.all([api('/worker/shifts/search', { method: 'POST', body: {} }), api<Booking[]>('/worker/bookings'), api<Offer[]>('/worker/offers')]);
    setShifts(f.items); setBookings(b); setOffers(o); setRadiusKm(f.radiusKm);
    await flushPending().catch(() => 0); // send check-ins saved while offline
    setSaved((await loadPending()).length);
  }), []);
  useEffect(() => { load(); }, [load]);
  const offered = offers.filter((o) => o.status === 'offered');

  return (
    <Screen>
      <View style={{ flexDirection: 'row', marginBottom: 8 }}>
        {(['shifts', 'mine', 'earnings', 'offers'] as const).map((k) => (
          <View key={k} style={{ flex: 1, marginHorizontal: 2 }}>
            <Big testID={`tab-${k}`} kind={tab === k ? 'primary' : 'secondary'} label={`${{ shifts: t.shifts, mine: t.myShifts, earnings: t.earnings, offers: t.offers }[k]}${k === 'offers' && offered.length ? ` (${offered.length})` : ''}`} onPress={() => go({ name: 'home', tab: k })} />
          </View>
        ))}
      </View>
      <Big kind="secondary" label={`↻ ${t.refresh}`} busy={busy} onPress={load} />
      {offered.length > 0 && tab !== 'offers' && <Banner kind="ok" text={`🔔 ${t.offerTitle}`} />}
      {saved > 0 && <Big kind="secondary" label={`📶 ${t.sendSaved} (${saved})`} busy={busy} onPress={load} />}
      <PendingConfirmations {...props} />
      {tab === 'earnings' && <EarningsTab {...props} />}

      {tab === 'shifts' && radiusKm != null && (
        <Big testID="change-area" kind="secondary" label={`📍 ${t.within} ${radiusKm} ${t.km} · ${t.change}`} onPress={() => go({ name: 'profile' })} />
      )}
      {tab === 'shifts' && (shifts?.length === 0 ? <T muted>{t.noShifts}</T> : shifts?.map((s) => (
        <Card key={s.id} testID={`shift-${s.id}`} onPress={() => go({ name: 'shift', id: s.id })}>
          <PayLine s={s} t={t} />
          <T size={19} bold>{s.title}</T>
          <T>🗓 {istDay(s.startsAt, lang)}  ⏰ {istTime(s.startsAt, lang)} – {istTime(s.endsAt, lang)}</T>
          <T>📍 {s.siteName}{s.distanceKm != null ? ` · ${s.distanceKm} ${t.km}` : ''}</T>
          <T muted>👥 {s.slotsLeft > 0 ? `${s.slotsLeft} ${t.slotsLeft}` : t.full} · {s.businessName}</T>
        </Card>
      )))}

      {tab === 'mine' && bookings?.map((b) => (
        <Card key={b.bookingId} testID={`booking-${b.bookingId}`} onPress={() => go(['confirmed', 'checked_in', 'completed'].includes(b.bookingStatus) ? { name: 'booking', bookingId: b.bookingId, shiftId: b.shift.id } : { name: 'shift', id: b.shift.id })}>
          <T size={19} bold>{b.shift.title}</T>
          <T>🗓 {istDay(b.shift.startsAt, lang)}  ⏰ {istTime(b.shift.startsAt, lang)}</T>
          <T muted>{b.bookingStatus === 'confirmed' ? `✓ ${t.booked}` : b.bookingStatus.startsWith('cancelled') ? t.cancelled : b.bookingStatus}</T>
        </Card>
      ))}

      {tab === 'offers' && offers.map((o) => (
        <Card key={o.id}>
          <T size={19} bold>{o.title}</T>
          <T>🗓 {istDay(o.startsAt, lang)}  ⏰ {istTime(o.startsAt, lang)}</T>
          {o.status === 'offered' ? (
            <>
              <Banner kind="ok" text={`${t.offerTitle}${o.expiresAt ? ` ⏳ ${istTime(o.expiresAt, lang)}` : ''}`} />
              <Big testID={`offer-accept-${o.id}`} label={t.acceptOffer} busy={busy} onPress={() => run(async () => { await api(`/worker/offers/${o.id}/accept`, { method: 'POST' }); await load(); go({ name: 'home', tab: 'mine' }); })} />
              <Big kind="secondary" label={t.decline} busy={busy} onPress={() => run(async () => { await api(`/worker/offers/${o.id}/decline`, { method: 'POST' }); await load(); })} />
            </>
          ) : <T muted>⏳ {t.waiting}</T>}
        </Card>
      ))}
      <Banner text={t.noFees} />
    </Screen>
  );
}

function ShiftScreen({ t, lang, go, setError, id }: P & { id: string }) {
  const [s, setS] = useState<Shift | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [done, setDone] = useState('');
  const { busy, run } = useBusy(setError);
  const load = useCallback(async () => {
    setS(await api<Shift>(`/worker/shifts/${id}`));
    const bs = await api<Booking[]>('/worker/bookings');
    setBooking(bs.find((b) => b.shift.id === id && b.bookingStatus === 'confirmed') ?? null);
  }, [id]);
  useEffect(() => { load().catch((e) => setError(showError(e))); }, [load, setError]);
  if (!s) return <Screen onBack={() => go({ name: 'home', tab: 'shifts' })} backLabel={t.back}><T>…</T></Screen>;
  const cancel = () => {
    const doIt = () => run(async () => { await api(`/worker/bookings/${booking!.bookingId}/cancel`, { method: 'POST' }); await load(); });
    if (Platform.OS === 'web') { if (globalThis.confirm?.(t.confirmCancel) ?? true) doIt(); }
    else Alert.alert(t.cancel, t.confirmCancel, [{ text: t.back }, { text: t.cancel, style: 'destructive', onPress: doIt }]);
  };
  return (
    <Screen onBack={() => go({ name: 'home', tab: 'shifts' })} backLabel={t.back} title={s.title}>
      <Card>
        <PayLine s={s} t={t} />
        {s.pay.takeHomePaise > s.pay.totalPaise && <T muted>{t.total}: {rupees(s.pay.totalPaise)} + {rupees(s.pay.takeHomePaise - s.pay.totalPaise)}</T>}
      </Card>
      <Card>
        <T bold>🗓 {t.when}</T>
        <T>{istDay(s.startsAt, lang)}, {istTime(s.startsAt, lang)} – {istTime(s.endsAt, lang)}{s.breakMinutes ? ` (${s.breakMinutes} min ${t.break})` : ''}</T>
        <T bold style={{ marginTop: 8 }}>📍 {t.where}</T>
        <T>{s.businessName} · {s.siteName}</T>
        <T muted>{s.address}</T>
        {s.dressCode ? <><T bold style={{ marginTop: 8 }}>👕 {t.dress}</T><T>{s.dressCode}</T></> : null}
        {s.bringItems ? <><T bold style={{ marginTop: 8 }}>🎒 {t.bring}</T><T>{s.bringItems}</T></> : null}
        {s.description ? <T muted style={{ marginTop: 8 }}>{s.description}</T> : null}
      </Card>
      {done ? <Banner kind="ok" text={done} /> : null}
      {booking ? (
        <>
          <Banner kind="ok" text={`✓ ${t.booked}`} />
          <Big testID="go-to-shift" label={t.goToShift} icon="📍" onPress={() => go({ name: 'booking', bookingId: booking.bookingId, shiftId: id })} />
          <Big kind="danger" label={t.cancel} busy={busy} onPress={cancel} />
        </>
      ) : !s.eligible ? (
        <Banner text={`${t.notEligible}. ${t.needs}: ${s.missing.join(', ')}`} />
      ) : s.slotsLeft > 0 ? (
        <Big testID="accept" label={t.accept} icon="✅" busy={busy} onPress={() => run(async () => { await api(`/worker/shifts/${id}/accept`, { method: 'POST' }); setDone(t.accepted); await load(); })} />
      ) : s.myWaitlist ? (
        <Big kind="secondary" label={t.leaveWaitlist} busy={busy} onPress={() => run(async () => { await api(`/worker/shifts/${id}/waitlist`, { method: 'DELETE' }); await load(); })} />
      ) : (
        <Big testID="waitlist" kind="secondary" label={t.joinWaitlist} busy={busy} onPress={() => run(async () => { await api(`/worker/shifts/${id}/waitlist`, { method: 'POST' }); await load(); })} />
      )}
      <Banner text={t.noFees} />
    </Screen>
  );
}
