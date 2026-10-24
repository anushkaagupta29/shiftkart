import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api, clearSession, istDay, istTime, rupees } from './api';
import { useBusy, type P } from './common';
import { Banner, Big, Card, Chip, Field, Screen, T, useColors } from './ui';

type Msg = { id: string; from: string; body: string; flags: string[]; status: string; at: string };

/** Chat with the business. Numbers stay hidden; payment requests and links never get through. */
export function ChatScreen({ t, lang, go, setError, bookingId, shiftId, title }: P & { bookingId: string; shiftId: string; title: string }) {
  const [d, setD] = useState<{ open: boolean; blocked: boolean; messages: Msg[] } | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useBusy(setError);
  const c = useColors();
  const load = useCallback(() => { api(`/worker/bookings/${bookingId}/chat`).then(setD).catch(() => {}); }, [bookingId]);
  useEffect(() => { load(); const i = setInterval(load, 8000); return () => clearInterval(i); }, [load]);
  if (!d) return <Screen><T>…</T></Screen>;
  return (
    <Screen title={`💬 ${title}`} onBack={() => go({ name: 'booking', bookingId, shiftId })} backLabel={t.back}>
      <Banner text={t.chatSafety} />
      {d.messages.map((m) => (
        <View key={m.id} style={{ alignSelf: m.from === 'me' ? 'flex-end' : 'flex-start', maxWidth: '85%', marginVertical: 4 }}>
          <View style={{ backgroundColor: m.from === 'me' ? (m.status === 'blocked' ? '#fde8e7' : c.green) : m.from === 'system' ? c.warnBg : c.card, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: c.border }}>
            <T color={m.from === 'me' && m.status !== 'blocked' ? c.greenText : undefined}>{m.body}</T>
            {m.status === 'blocked' && <T size={13} color={c.red}>{t.notSent}</T>}
          </View>
          <T muted size={12}>{istTime(m.at, lang)}</T>
          {m.from === 'business' && <Chip label={`🚩 ${t.report}`} on={false} onPress={() => run(async () => { await api(`/worker/messages/${m.id}/report`, { method: 'POST', body: { reason: 'Reported by worker' } }); setNote(t.reported); })} />}
        </View>
      ))}
      {note ? <Banner kind="ok" text={note} /> : null}
      {d.open ? (
        <>
          <Field testID="chat-input" label={t.message} value={text} onChangeText={setText} multiline style={{ fontSize: 18, minHeight: 60 }} />
          <Big testID="chat-send" label={t.send} busy={busy} disabled={!text.trim()} onPress={() => run(async () => {
            const r = await api(`/worker/bookings/${bookingId}/chat`, { method: 'POST', body: { text } });
            setText(''); if (r.notice) setNote(r.notice); else setNote('');
            load();
          })} />
          <Big kind="secondary" icon="📞" label={t.callMasked} busy={busy} onPress={() => run(async () => { await api(`/worker/bookings/${bookingId}/call`, { method: 'POST' }); load(); })} />
        </>
      ) : <Banner text={d.blocked ? t.youBlocked : t.chatClosed} />}
    </Screen>
  );
}

/** After the shift: rate the business (blind), report problems, or block. */
export function AfterShiftCard({ t, setError, bookingId, businessId }: P & { bookingId: string; businessId: string }) {
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const [mismatch, setMismatch] = useState('');
  const { busy, run } = useBusy(setError);
  const TAGS = ['paid_fairly', 'respectful', 'clear_instructions', 'disorganised', 'unsafe_site', 'rude'];
  return (
    <Card>
      <T bold>⭐ {t.rateBusiness}</T>
      <T muted size={14}>{t.ratingBlind}</T>
      <View style={{ flexDirection: 'row', marginVertical: 6 }}>
        {[1, 2, 3, 4, 5].map((n) => <Chip key={n} testID={`star-${n}`} label={'★'.repeat(n)} on={stars === n} onPress={() => setStars(n)} />)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{TAGS.map((g) => <Chip key={g} label={t.tags[g as keyof typeof t.tags] ?? g} on={tags.includes(g)} onPress={() => setTags(tags.includes(g) ? tags.filter((x) => x !== g) : [...tags, g])} />)}</View>
      {done ? <Banner kind="ok" text={done} /> : <Big testID="rate-submit" label={t.submit} busy={busy} disabled={!stars} onPress={() => run(async () => { await api(`/worker/bookings/${bookingId}/rating`, { method: 'POST', body: { stars, tags } }); setDone(t.thanks); })} />}
      <T bold style={{ marginTop: 12 }}>⚠️ {t.mismatchTitle}</T>
      <Field label={t.whatHappened} value={mismatch} onChangeText={setMismatch} multiline style={{ fontSize: 17, minHeight: 50 }} />
      <Big kind="secondary" label={t.report} busy={busy} disabled={mismatch.trim().length < 10} onPress={() => run(async () => { await api(`/worker/bookings/${bookingId}/report-mismatch`, { method: 'POST', body: { details: mismatch } }); setMismatch(''); setDone(t.reported); })} />
      <Big kind="secondary" label={`🚫 ${t.blockBusiness}`} busy={busy} onPress={() => run(async () => { await api(`/worker/blocks/${businessId}`, { method: 'POST', body: {} }); setDone(t.blocked); })} />
    </Card>
  );
}

/** SOS, trusted contact, and reporting harassment or unsafe conditions (anonymous allowed). */
export function SafetyScreen({ t, go, setError, bookingId }: P & { bookingId?: string }) {
  const [contact, setContact] = useState({ name: '', phone: '' });
  const [share, setShare] = useState(true);
  const [sos, setSos] = useState('');
  const [cat, setCat] = useState('harassment');
  const [desc, setDesc] = useState('');
  const [anon, setAnon] = useState(false);
  const [msg, setMsg] = useState('');
  const { busy, run } = useBusy(setError);
  const c = useColors();
  const pressSos = () => run(async () => {
    let fix = { lat: 0, lng: 0, accuracyM: 9999 };
    try {
      await Location.requestForegroundPermissionsAsync();
      const p = await Location.getCurrentPositionAsync({});
      fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy ?? 999) };
    } catch { /* still raise the alarm without a location */ }
    const r = await api('/worker/sos', { method: 'POST', body: { ...(bookingId ? { bookingId } : {}), ...fix, shareWithContact: share } });
    setSos(r.message);
  });
  return (
    <Screen title={`🛡️ ${t.safety}`} onBack={() => go({ name: 'home', tab: 'mine' })} backLabel={t.back}>
      <Big testID="sos" kind="danger" icon="🆘" label={t.sosButton} busy={busy} onPress={pressSos} />
      <Chip label={t.shareLocation} on={share} onPress={() => setShare(!share)} />
      {sos ? <Banner kind="error" text={sos} /> : <T muted>{t.sosHelp}</T>}
      <Card>
        <T bold>👤 {t.trustedContact}</T>
        <Field label={t.name} value={contact.name} onChangeText={(v) => setContact({ ...contact, name: v })} />
        <Field label={t.phone} keyboardType="phone-pad" value={contact.phone} onChangeText={(v) => setContact({ ...contact, phone: v })} />
        <Big kind="secondary" label={t.save} busy={busy} onPress={() => run(async () => { await api('/worker/trusted-contact', { method: 'PUT', body: contact }); setMsg(t.saved); })} />
      </Card>
      <Card>
        <T bold>📝 {t.reportProblem}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {(['harassment', 'unsafe_site', 'injury', 'payment_demand', 'discrimination', 'other'] as const).map((k) => <Chip key={k} label={t.incident[k]} on={cat === k} onPress={() => setCat(k)} />)}
        </View>
        <Field testID="incident-text" label={t.whatHappened} value={desc} onChangeText={setDesc} multiline style={{ fontSize: 17, minHeight: 70 }} />
        <Chip testID="incident-anon" label={t.anonymous} on={anon} onPress={() => setAnon(!anon)} />
        {anon && <T muted size={14}>{t.anonymousNote}</T>}
        <Big testID="incident-send" label={t.submit} busy={busy} disabled={desc.trim().length < 10} onPress={() => run(async () => {
          const r = await api('/worker/incidents', { method: 'POST', body: { category: cat, description: desc, anonymous: anon, ...(bookingId && !anon ? { bookingId } : {}) } });
          setDesc(''); setMsg(r.message);
        })} />
      </Card>
      {msg ? <Banner kind="ok" text={msg} /> : null}
      <T muted style={{ color: c.muted }}>{t.emergency112}</T>
    </Screen>
  );
}

type Strikes = { points: number; level: string; limitAt: number; holdAt: number; rating: { score: number; count: number }; items: { id: string; kind: string; points: number; status: string; emergency: boolean; shiftTitle: string; expiresAt: string; decisionReason: string | null; at: string }[] };
type Case = { id: string; kind: string; status: string; summary: string; shiftTitle: string | null; createdAt: string };

/** "Me": reliability, rating, strikes with appeals, and disputes. */
export function MeScreen({ t, lang, go, setError }: P) {
  const [s, setS] = useState<Strikes | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [appeal, setAppeal] = useState<{ id: string; text: string } | null>(null);
  const { busy, run } = useBusy(setError);
  const load = useCallback(() => {
    api<Strikes>('/worker/strikes').then(setS).catch(() => {});
    api<Case[]>('/worker/disputes').then(setCases).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (!s) return <Screen><T>…</T></Screen>;
  return (
    <Screen title={`👤 ${t.me}`} onBack={() => go({ name: 'home', tab: 'shifts' })} backLabel={t.back}>
      <Card>
        <T size={22} bold>⭐ {s.rating.score.toFixed(1)}  <T muted>({s.rating.count})</T></T>
        <T>{t.strikePoints}: {s.points} · {s.level === 'ok' ? t.levelOk : s.level === 'limited' ? t.levelLimited : t.levelHold}</T>
        <T muted size={14}>{t.strikeRules(s.limitAt, s.holdAt)}</T>
      </Card>
      {s.items.map((k) => (
        <Card key={k.id}>
          <T bold>{k.kind === 'no_show' ? t.noShow : t.lateCancel} · {k.points} {t.pointsWord}</T>
          <T muted>{k.shiftTitle} · {istDay(k.at, lang)}</T>
          <T>{t.strikeStatus[k.status as keyof typeof t.strikeStatus] ?? k.status}{k.decisionReason ? `: ${k.decisionReason}` : ''}</T>
          {k.status === 'active' && (appeal?.id === k.id ? (
            <>
              <Field label={t.appealWhy} value={appeal.text} onChangeText={(v) => setAppeal({ id: k.id, text: v })} multiline style={{ fontSize: 17, minHeight: 60 }} />
              <Big label={t.submit} busy={busy} disabled={appeal.text.trim().length < 10} onPress={() => run(async () => { await api(`/worker/strikes/${k.id}/appeal`, { method: 'POST', body: { reason: appeal.text } }); setAppeal(null); load(); })} />
            </>
          ) : <Big kind="secondary" label={t.appeal} onPress={() => setAppeal({ id: k.id, text: '' })} />)}
        </Card>
      ))}
      <T bold style={{ marginTop: 12 }}>⚖️ {t.disputes}</T>
      {cases.length === 0 && <T muted>{t.noDisputes}</T>}
      {cases.map((c) => (
        <Card key={c.id} onPress={() => go({ name: 'dispute', id: c.id })}>
          <T bold>{c.shiftTitle ?? c.kind}</T>
          <T>{t.caseStatus[c.status as keyof typeof t.caseStatus] ?? c.status}</T>
          <T muted size={14}>{c.summary}</T>
        </Card>
      ))}
      <Big kind="secondary" icon="🛡️" label={t.safety} onPress={() => go({ name: 'safety' })} />
      <MessageSettings {...{ t, setError }} />
      <Big testID="privacy" kind="secondary" icon="🔒" label={t.privacy} onPress={() => go({ name: 'privacy' })} />
    </Screen>
  );
}

export function DisputeScreen({ t, lang, go, setError, id }: P & { id: string }) {
  const [c, setC] = useState<{ status: string; summary: string; decideDueAt: string; decision: string | null; decisionReason: string | null; timeline: { by: string; type: string; body: string; at: string }[] } | null>(null);
  const [text, setText] = useState('');
  const { busy, run } = useBusy(setError);
  const load = useCallback(() => { api(`/worker/disputes/${id}`).then(setC).catch(() => {}); }, [id]);
  useEffect(load, [load]);
  if (!c) return <Screen><T>…</T></Screen>;
  return (
    <Screen title={`⚖️ ${t.disputes}`} onBack={() => go({ name: 'me' })} backLabel={t.back}>
      <Banner text={`${t.caseStatus[c.status as keyof typeof t.caseStatus] ?? c.status} · ${t.decisionBy} ${istDay(c.decideDueAt, lang)}`} />
      {c.timeline.map((e, i) => (
        <Card key={i}>
          <T muted size={13}>{e.by === 'worker' ? t.you : e.by === 'business' ? t.businessWord : e.by === 'ops' ? 'ShiftKart' : ''} · {istDay(e.at, lang)} {istTime(e.at, lang)}</T>
          <T bold={e.type === 'decision'}>{e.body}</T>
        </Card>
      ))}
      {['open', 'under_review'].includes(c.status) && (
        <>
          <Field label={t.yourSide} value={text} onChangeText={setText} multiline style={{ fontSize: 17, minHeight: 70 }} />
          <Big label={t.send} busy={busy} disabled={text.trim().length < 2} onPress={() => run(async () => { await api(`/worker/disputes/${id}/statements`, { method: 'POST', body: { body: text } }); setText(''); load(); })} />
        </>
      )}
    </Screen>
  );
}

type Hire = { id: string; status: string; roleTitle: string; monthlySalaryPaise: number | null; message: string; business: string; contact: string | null };

/** Full-time job offers. The worker never pays anything and can always say no. */
export function HireOffers({ t, setError }: P) {
  const [items, setItems] = useState<Hire[]>([]);
  const { busy, run } = useBusy(setError);
  const load = useCallback(() => { api<Hire[]>('/worker/hire-requests').then(setItems).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (!items.length) return null;
  return (
    <>
      {items.map((h) => (
        <Card key={h.id}>
          <T bold>💼 {t.jobOffer}: {h.roleTitle}</T>
          <T>{h.business}{h.monthlySalaryPaise ? ` · ${rupees(h.monthlySalaryPaise)}/${t.month}` : ''}</T>
          {h.message ? <T muted>{h.message}</T> : null}
          <T muted size={14}>{t.jobOfferNote}</T>
          {h.status === 'offered' && (
            <>
              <Big label={t.interested} busy={busy} onPress={() => run(async () => { await api(`/worker/hire-requests/${h.id}/accept`, { method: 'POST' }); load(); })} />
              <Big kind="secondary" label={t.notInterested} busy={busy} onPress={() => run(async () => { await api(`/worker/hire-requests/${h.id}/decline`, { method: 'POST' }); load(); })} />
            </>
          )}
          {h.status === 'accepted' && <T>{t.waitingBusiness}</T>}
          {h.status === 'paid' && h.contact && <Banner kind="ok" text={`${t.contactThem}: ${h.contact}`} />}
          {h.status === 'declined' && <T muted>{t.declined}</T>}
        </Card>
      ))}
    </>
  );
}

function MessageSettings({ t, setError }: Pick<P, 't' | 'setError'>) {
  const [p, setP] = useState<{ whatsappOptIn: boolean; remindersOptOut: boolean } | null>(null);
  const { run } = useBusy(setError);
  useEffect(() => { api('/me/notifications').then(setP).catch(() => {}); }, []);
  if (!p) return null;
  const save = (next: typeof p) => run(async () => { setP(await api('/me/notifications', { method: 'PUT', body: next })); });
  return (
    <Card>
      <T bold>✉️ {t.settings}</T>
      <Chip testID="wa-optin" label={t.whatsappOptIn} on={p.whatsappOptIn} onPress={() => save({ ...p, whatsappOptIn: !p.whatsappOptIn })} />
      <Chip label={t.remindersOptOut} on={p.remindersOptOut} onPress={() => save({ ...p, remindersOptOut: !p.remindersOptOut })} />
      <T muted size={14}>{t.settingsNote}</T>
    </Card>
  );
}

type Consents = Partial<Record<'location_at_shift' | 'face_verification' | 'notifications', boolean>>;
type Grievance = { appointed: boolean; name: string | null; email: string | null };

/** DPDP data rights: see what we hold, switch purposes off, leave (SPEC §6.12). */
export function PrivacyScreen({ t, go, setError }: P) {
  const [c, setC] = useState<Consents | null>(null);
  const [g, setG] = useState<Grievance | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { busy, run } = useBusy(setError);
  useEffect(() => {
    api<Consents>('/me/consents').then(setC).catch(() => {});
    api<Grievance>('/legal/grievance').then(setG).catch(() => {});
  }, []);
  const toggle = (purpose: keyof Consents) => run(async () => {
    const on = c?.[purpose] !== false;
    await api(`/me/consents/${purpose}/${on ? 'withdraw' : 'grant'}`, { method: 'POST' });
    setC(await api<Consents>('/me/consents'));
  });
  const download = () => run(async () => {
    const json = JSON.stringify(await api('/me/export'), null, 2);
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = 'shiftkart-my-data.json';
      a.click();
    } else {
      await Share.share({ message: json, title: 'shiftkart-my-data.json' });
    }
  });
  if (done) return <Screen title={t.privacy}><Banner kind="ok" text={t.deleted} /><Big label={t.back} onPress={() => go({ name: 'lang' })} /></Screen>;
  return (
    <Screen title={`🔒 ${t.privacy}`} onBack={() => go({ name: 'me' })} backLabel={t.back}>
      <T muted>{t.privacyNote}</T>
      <Big testID="download-data" kind="secondary" icon="⬇️" label={t.downloadData} busy={busy} onPress={download} />
      {c && (
        <Card>
          {/* No row yet means the purpose was never switched off: shown as on. */}
          <Chip testID="consent-location" label={t.privLocation} on={c.location_at_shift !== false} onPress={() => toggle('location_at_shift')} />
          <Chip testID="consent-face" label={t.privFace} on={c.face_verification !== false} onPress={() => toggle('face_verification')} />
          {c.face_verification === false && <T muted size={14}>{t.faceOffWarn}</T>}
          <Chip testID="consent-notifications" label={t.privNotif} on={c.notifications !== false} onPress={() => toggle('notifications')} />
        </Card>
      )}
      <Card>
        <T bold>📮 {t.grievance}</T>
        {g?.appointed ? <T>{g.name} · {g.email}</T> : <T muted size={14}>{t.grievanceDraft}</T>}
      </Card>
      <Card>
        <T bold>{t.deleteAccount}</T>
        <T muted size={14}>{t.deleteWarn}</T>
        {confirm === null ? (
          <Big testID="delete-account" kind="danger" label={t.deleteAccount} onPress={() => setConfirm('')} />
        ) : (
          <>
            <Field testID="delete-confirm" label={t.typeDelete} value={confirm} onChangeText={setConfirm} autoCapitalize="characters" />
            <Big testID="delete-account-go" kind="danger" label={t.deleteAccount} busy={busy} disabled={confirm !== 'DELETE'} onPress={() => run(async () => {
              await api('/me/delete', { method: 'POST', body: { confirm: 'DELETE' } });
              await clearSession();
              setDone(true);
            })} />
          </>
        )}
      </Card>
    </Screen>
  );
}
