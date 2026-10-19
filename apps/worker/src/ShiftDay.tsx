import * as Location from 'expo-location';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Platform } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { ApiError, api, istDay, istTime, loadPending, rupees, savePending } from './api';
import { useBusy, type P, type Shift } from './common';
import { Banner, Big, Card, Chip, Field, Screen, Speak, T } from './ui';
import { AfterShiftCard } from './Trust';

type Attendance = {
  bookingStatus: string; confirmedAttendance: boolean | null; onBreak: boolean;
  events: { id: string; type: string; mode: string; status: string; at: string; flags: string[] }[];
  overtime: { id: string; extraMinutes: number; workerPayPaise: number; status: string }[];
  timesheet: { id: string; status: string; minutes: number; grossPaise: number; heldPaise: number; approvalDeadline: string } | null;
};
type Fix = { lat: number; lng: number; accuracyM: number; mocked: boolean };

/** In the test build, the "selfie" uses the face of the test identity picked on the DigiLocker screen. */
async function selfieFor(): Promise<{ mockPersonId: string }> {
  const f = await api('/dev/my-face').catch(() => null);
  return { mockPersonId: f?.personId ?? 'unknown' };
}

async function getFix(): Promise<Fix> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('no-permission');
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  // Android reports when a fake-GPS app supplied the location (WRK-04).
  return { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy ?? 999), mocked: Boolean((p as { mocked?: boolean }).mocked) };
}

export function BookingScreen(props: P & { bookingId: string; shiftId: string }) {
  const { t, lang, go, setError, bookingId, shiftId } = props;
  const [shift, setShift] = useState<Shift & { lat?: number; lng?: number } | null>(null);
  const [att, setAtt] = useState<Attendance | null>(null);
  const [code, setCode] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const [locMsg, setLocMsg] = useState('');
  const [fakeGps, setFakeGps] = useState(false);
  const [rooted, setRooted] = useState(false);
  const [note, setNote] = useState('');
  const [scanning, setScanning] = useState(false);
  const [camPerm, askCam] = useCameraPermissions();
  const { busy, run } = useBusy(setError);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([api(`/worker/shifts/${shiftId}`), api<Attendance>(`/worker/bookings/${bookingId}/attendance`)]);
    setShift(s); setAtt(a);
  }, [bookingId, shiftId]);
  useEffect(() => { load().catch((e) => setError(e instanceof ApiError ? e.message : String(e))); }, [load, setError]);

  const locate = async () => {
    setLocMsg(t.locating);
    try { setFix(await getFix()); setLocMsg(t.locationOk); } catch { setLocMsg(t.locationFail); }
  };
  useEffect(() => { if (att && ['confirmed', 'checked_in'].includes(att.bookingStatus)) locate(); }, [att?.bookingStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const clock = (kind: 'check-in' | 'check-out') => run(async () => {
    if (!fix) { setLocMsg(t.locationFail); return; }
    const body = {
      code: code.trim(), lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, mockLocation: fix.mocked || fakeGps,
      integrityToken: rooted ? 'mock:fail' : 'mock:pass', selfie: await selfieFor(),
    };
    try {
      await api(`/worker/bookings/${bookingId}/${kind}`, { method: 'POST', body });
      setCode(''); setNote(kind === 'check-in' ? t.onShift : t.checkedOut);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'offline') {
        // No network: keep the scan with the time it happened; it's sent from the home screen later.
        const list = await loadPending();
        await savePending([...list, { bookingId, kind, body: { ...body, offlineOccurredAt: new Date().toISOString() } }]);
        setNote(t.savedOffline);
        return;
      }
      throw e;
    }
    await load();
  });

  if (!shift || !att) return <Screen onBack={() => go({ name: 'home', tab: 'mine' })} backLabel={t.back}><T>…</T></Screen>;
  const checkIn = att.events.find((e) => e.type === 'check_in');
  const checkOut = att.events.find((e) => e.type === 'check_out');
  const openOt = att.overtime.find((o) => o.status === 'awaiting_worker');

  const codeEntry = (kind: 'check-in' | 'check-out') => (
    <Card>
      {Platform.OS !== 'web' && (scanning ? (
        <View style={{ height: 260, borderRadius: 12, overflow: 'hidden', marginVertical: 6 }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => { if (data.startsWith('sk1.')) { setCode(data); setScanning(false); } }} />
        </View>
      ) : (
        <Big kind="secondary" icon="📷" label={t.scanQr} onPress={async () => { const p = camPerm?.granted ? camPerm : await askCam(); if (p?.granted) setScanning(true); else setLocMsg(t.cameraDenied); }} />
      ))}
      {code.startsWith('sk1.') ? <Banner kind="ok" text={`✓ QR`} /> : <Field testID="gate-code" label={`🔢 ${t.enterCode}`} keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />}
      <T muted>{t.codeHelp}</T>
      <Speak lang={lang} label={t.listen} text={`${t.codeHelp} ${t.enterCode}. ${t.selfieNext}`} />
      <T style={{ marginTop: 8 }}>📍 {locMsg || t.locating}{fix ? ` (±${fix.accuracyM} m)` : ''}</T>
      {__DEV__ && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
          <Chip testID="test-at-site" label={t.testAtSite} on={false} onPress={() => { if (shift.lat != null) { setFix({ lat: shift.lat, lng: shift.lng!, accuracyM: 15, mocked: false }); setLocMsg(t.locationOk); } }} />
          <Chip label={t.testFakeGps} on={fakeGps} onPress={() => setFakeGps(!fakeGps)} />
          <Chip label={t.testRooted} on={rooted} onPress={() => setRooted(!rooted)} />
        </View>
      )}
      <T muted style={{ marginTop: 6 }}>🤳 {t.selfieNext}</T>
      <Big testID={kind} label={kind === 'check-in' ? t.checkIn : t.checkOut} icon={kind === 'check-in' ? '✅' : '🏁'} busy={busy} disabled={!(code.trim().length === 6 || code.startsWith('sk1.'))} onPress={() => clock(kind)} />
    </Card>
  );

  return (
    <Screen title={shift.title} onBack={() => go({ name: 'home', tab: 'mine' })} backLabel={t.back}>
      <T>🗓 {istDay(shift.startsAt, lang)}, {istTime(shift.startsAt, lang)} – {istTime(shift.endsAt, lang)}</T>
      <T muted>📍 {shift.siteName}, {shift.address}</T>
      {note ? <Banner kind="ok" text={note} /> : null}
      <View style={{ flexDirection: 'row' }}>
        <View style={{ flex: 1, marginRight: 4 }}><Big testID="open-chat" kind="secondary" icon="💬" label={t.chat} onPress={() => go({ name: 'chat', bookingId, shiftId, title: shift.title })} /></View>
        <View style={{ flex: 1, marginLeft: 4 }}><Big testID="open-safety" kind={att.bookingStatus === 'checked_in' ? 'danger' : 'secondary'} icon="🛡️" label={att.bookingStatus === 'checked_in' ? 'SOS' : t.safety} onPress={() => go({ name: 'safety', bookingId })} /></View>
      </View>

      {att.bookingStatus === 'confirmed' && att.confirmedAttendance === null && (
        <Card>
          <T bold>🙋 {t.areYouComing}</T>
          <Big testID="coming-yes" label={t.imComing} busy={busy} onPress={() => run(async () => { await api(`/worker/bookings/${bookingId}/intent`, { method: 'POST', body: { coming: true } }); setNote(t.comingSaved); await load(); })} />
          <Big testID="coming-no" kind="secondary" label={t.cantCome} busy={busy} onPress={() => run(async () => { await api(`/worker/bookings/${bookingId}/intent`, { method: 'POST', body: { coming: false } }); go({ name: 'shift', id: shiftId }); })} />
        </Card>
      )}
      {att.bookingStatus === 'confirmed' && codeEntry('check-in')}

      {att.bookingStatus === 'checked_in' && (
        <>
          <Banner kind="ok" text={`✓ ${att.onBreak ? t.onBreakNow : t.onShift}${checkIn ? ` · ${t.arrivedAt} ${istTime(checkIn.at, lang)}` : ''}`} />
          {openOt && (
            <Card>
              <T bold>⏱ {t.overtimeOffer}: +{openOt.extraMinutes} {t.minutes} = {rupees(openOt.workerPayPaise)}</T>
              <Big testID="ot-accept" label={t.stay} busy={busy} onPress={() => run(async () => { await api(`/worker/overtime/${openOt.id}/accept`, { method: 'POST' }); await load(); })} />
              <Big kind="secondary" label={t.noStay} busy={busy} onPress={() => run(async () => { await api(`/worker/overtime/${openOt.id}/decline`, { method: 'POST' }); await load(); })} />
            </Card>
          )}
          <Big testID="break" kind="secondary" icon="☕" label={att.onBreak ? t.breakEnd : t.breakStart} busy={busy}
            onPress={() => run(async () => { await api(`/worker/bookings/${bookingId}/break`, { method: 'POST', body: { action: att.onBreak ? 'end' : 'start' } }); await load(); })} />
          {codeEntry('check-out')}
        </>
      )}

      {att.bookingStatus === 'completed' && (
        <Card>
          <T bold>🏁 {t.checkedOut}</T>
          {checkIn && checkOut && <T muted>{t.arrivedAt} {istTime(checkIn.at, lang)} · {t.leftAt} {istTime(checkOut.at, lang)}</T>}
          {att.timesheet && (
            <>
              <T size={28} bold color="#0b6e4f">{rupees(att.timesheet.grossPaise - att.timesheet.heldPaise)}</T>
              {att.timesheet.heldPaise > 0 && <T muted>+ {rupees(att.timesheet.heldPaise)} {t.held}</T>}
              <T>{['pending_approval', 'awaiting_confirmation'].includes(att.timesheet.status) ? `⏳ ${t.waitingApproval}` : `✅ ${t.approvedPaying}`}</T>
            </>
          )}
          <Big kind="secondary" label={t.earnings} onPress={() => go({ name: 'home', tab: 'earnings' })} />
        </Card>
      )}
      {['completed', 'turned_away'].includes(att.bookingStatus) && shift.businessId && <AfterShiftCard {...props} bookingId={bookingId} businessId={shift.businessId} />}
      <Banner text={t.noFees} />
    </Screen>
  );
}

/** Attendance a supervisor marked by hand: the worker confirms it with a selfie, or says it's wrong (PAY-12). */
export function PendingConfirmations({ t, lang, setError }: P) {
  const [items, setItems] = useState<{ id: string; type: string; at: string; shiftTitle: string }[]>([]);
  const { busy, run } = useBusy(setError);
  const load = useCallback(() => { api('/worker/attendance/pending').then(setItems).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (!items.length) return null;
  return (
    <Card>
      <T bold>✍️ {t.confirmManualTitle}</T>
      {items.map((i) => (
        <View key={i.id} style={{ marginTop: 8 }}>
          <T>{i.shiftTitle}: {i.type === 'check_in' ? t.arrivedAt : t.leftAt} {istDay(i.at, lang)} {istTime(i.at, lang)}</T>
          <Big label={t.confirmManual} busy={busy} onPress={() => run(async () => { await api(`/worker/attendance/${i.id}/confirm`, { method: 'POST', body: { selfie: await selfieFor() } }); load(); })} />
          <Big kind="secondary" label={t.wrong} busy={busy} onPress={() => run(async () => { await api(`/worker/attendance/${i.id}/reject`, { method: 'POST' }); load(); })} />
        </View>
      ))}
    </Card>
  );
}

type Payslips = { items: { id: string; number: string; netPaise: number; paidAt: string; shift: { title: string; business: string } | null }[]; onTheWay: { paise: number; count: number; heldReason: string | null } };

export function EarningsTab({ t, lang, go }: P) {
  const [d, setD] = useState<Payslips | null>(null);
  useEffect(() => { api<Payslips>('/worker/payslips').then(setD).catch(() => {}); }, []);
  if (!d) return <T>…</T>;
  return (
    <>
      {d.onTheWay.count > 0 && <Banner kind="ok" text={`⏳ ${t.onTheWay}: ${rupees(Number(d.onTheWay.paise))}`} />}
      {d.onTheWay.heldReason && ['no_payout_method', 'beneficiary_account_closed', 'returned_by_bank'].includes(d.onTheWay.heldReason) && <Banner kind="error" text={t.heldPay} />}
      {d.items.length === 0 && <T muted>{t.noPayslips}</T>}
      {d.items.map((p) => (
        <Card key={p.id} testID={`payslip-${p.id}`} onPress={() => go({ name: 'payslip', id: p.id })}>
          <T size={24} bold color="#0b6e4f">{rupees(p.netPaise)}</T>
          <T>{p.shift ? `${p.shift.title} · ${p.shift.business}` : p.number}</T>
          <T muted>{istDay(p.paidAt, lang)}</T>
        </Card>
      ))}
    </>
  );
}

export function PayslipScreen({ t, lang, go, id }: P & { id: string }) {
  const [p, setP] = useState<{ number: string; issuedAt: string; shift: { title: string; business: string; date: string } | null; lines: { label: string; detail?: string; paise: number }[]; netPaise: number; paidTo: string; noFeesNotice: string } | null>(null);
  useEffect(() => { api(`/worker/payslips/${id}`).then(setP).catch(() => {}); }, [id]);
  if (!p) return <Screen onBack={() => go({ name: 'home', tab: 'earnings' })} backLabel={t.back}><T>…</T></Screen>;
  return (
    <Screen title={t.payslip} onBack={() => go({ name: 'home', tab: 'earnings' })} backLabel={t.back}>
      <Card>
        <T muted>{p.number} · {istDay(p.issuedAt, lang)}</T>
        {p.shift && <T bold>{p.shift.title} · {p.shift.business}</T>}
        {p.lines.map((l, i) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
            <View style={{ flex: 1 }}><T>{l.label}</T>{l.detail ? <T muted size={14}>{l.detail}</T> : null}</View>
            <T bold>{l.paise < 0 ? '−' : ''}{rupees(Math.abs(l.paise))}</T>
          </View>
        ))}
        <View style={{ borderTopWidth: 1, borderColor: '#ccc', marginTop: 10, paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' }}>
          <T bold>{t.net}</T><T size={22} bold color="#0b6e4f">{rupees(p.netPaise)}</T>
        </View>
        <T muted>{t.paidTo}: {p.paidTo}</T>
      </Card>
      <Banner text={t.noFees} />
    </Screen>
  );
}
