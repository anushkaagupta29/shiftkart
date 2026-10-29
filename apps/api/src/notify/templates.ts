// Notification texts in the three launch languages. Short, plain words; amounts in ₹.
// The Kannada and Hindi wording needs review by native speakers before launch (DECISIONS D-040).
// For production SMS, each template must be registered on DLT (LEGAL L-29); `dltId` is filled in then.

export type Lang = 'en' | 'hi' | 'kn';
type Vars = Record<string, string | number>;
export type Template = { critical: boolean; whatsapp: boolean; reminder?: boolean; dltId?: string; text: Record<Lang, (v: Vars) => string> };

const rs = (p: string | number | undefined) => `₹${(Number(p ?? 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
const NO_FEES = { en: 'ShiftKart never asks for money.', hi: 'ShiftKart कभी पैसे नहीं मांगता।', kn: 'ShiftKart ಎಂದಿಗೂ ಹಣ ಕೇಳುವುದಿಲ್ಲ.' };

export const TEMPLATES = {
  shift_reminder_24h: { critical: false, whatsapp: true, reminder: true, text: {
    en: (v) => `ShiftKart: reminder, "${v.title}" tomorrow ${v.time} at ${v.site}. Open the app and tap "I'm coming" or "I can't come".`,
    hi: (v) => `ShiftKart: याद रखें, कल ${v.time} बजे "${v.title}", ${v.site}। ऐप खोलें और "मैं आ रहा/रही हूं" या "नहीं आ पाऊंगा/पाऊंगी" दबाएं।`,
    kn: (v) => `ShiftKart: ನೆನಪಿಸುತ್ತಿದ್ದೇವೆ, ನಾಳೆ ${v.time}ಕ್ಕೆ "${v.title}", ${v.site}. ಆ್ಯಪ್ ತೆರೆದು "ನಾನು ಬರುತ್ತೇನೆ" ಅಥವಾ "ಬರಲಾಗುವುದಿಲ್ಲ" ಒತ್ತಿ.`,
  } },
  shift_reminder_3h: { critical: false, whatsapp: true, reminder: true, text: {
    en: (v) => `ShiftKart: "${v.title}" starts at ${v.time} at ${v.site}. Bring: ${v.bring}. Ask the supervisor for the check-in code.`,
    hi: (v) => `ShiftKart: "${v.title}" ${v.time} बजे ${v.site} पर शुरू। साथ लाएं: ${v.bring}। चेक-इन कोड सुपरवाइज़र से लें।`,
    kn: (v) => `ShiftKart: "${v.title}" ${v.time}ಕ್ಕೆ ${v.site}ನಲ್ಲಿ ಆರಂಭ. ತನ್ನಿ: ${v.bring}. ಚೆಕ್-ಇನ್ ಕೋಡ್ ಸೂಪರ್‌ವೈಸರ್‌ರಿಂದ ಪಡೆಯಿರಿ.`,
  } },
  waitlist_offer: { critical: true, whatsapp: true, text: {
    en: (v) => `ShiftKart: a place opened on "${v.title}". Accept within ${v.minutes} min in the app.`,
    hi: (v) => `ShiftKart: "${v.title}" में जगह खुली है। ${v.minutes} मिनट में ऐप में स्वीकार करें।`,
    kn: (v) => `ShiftKart: "${v.title}"ನಲ್ಲಿ ಜಾಗ ಖಾಲಿಯಾಗಿದೆ. ${v.minutes} ನಿಮಿಷದೊಳಗೆ ಆ್ಯಪ್‌ನಲ್ಲಿ ಒಪ್ಪಿಕೊಳ್ಳಿ.`,
  } },
  overtime_offer: { critical: true, whatsapp: true, text: {
    en: (v) => `ShiftKart: overtime offered, ${v.minutes} min for ${rs(v.paise)}. Accept or decline in the app.`,
    hi: (v) => `ShiftKart: ओवरटाइम का ऑफर, ${v.minutes} मिनट के ${rs(v.paise)}। ऐप में हां या ना करें।`,
    kn: (v) => `ShiftKart: ಹೆಚ್ಚುವರಿ ಸಮಯ, ${v.minutes} ನಿಮಿಷಕ್ಕೆ ${rs(v.paise)}. ಆ್ಯಪ್‌ನಲ್ಲಿ ಒಪ್ಪಿ ಅಥವಾ ನಿರಾಕರಿಸಿ.`,
  } },
  payout_sent: { critical: false, whatsapp: true, text: {
    en: (v) => `ShiftKart: ${rs(v.paise)} sent to ${v.to}. Your payslip is in the app. ${NO_FEES.en}`,
    hi: (v) => `ShiftKart: ${rs(v.paise)} ${v.to} पर भेजे गए। पे-स्लिप ऐप में है। ${NO_FEES.hi}`,
    kn: (v) => `ShiftKart: ${rs(v.paise)} ${v.to}ಗೆ ಕಳುಹಿಸಲಾಗಿದೆ. ಪೇ-ಸ್ಲಿಪ್ ಆ್ಯಪ್‌ನಲ್ಲಿದೆ. ${NO_FEES.kn}`,
  } },
  payout_held: { critical: true, whatsapp: true, text: {
    en: () => 'ShiftKart: we could not send your pay. Please check your UPI / bank details in the app.',
    hi: () => 'ShiftKart: आपका भुगतान नहीं भेज पाए। ऐप में अपना UPI / बैंक जांचें।',
    kn: () => 'ShiftKart: ನಿಮ್ಮ ಹಣ ಕಳುಹಿಸಲಾಗಲಿಲ್ಲ. ಆ್ಯಪ್‌ನಲ್ಲಿ UPI / ಬ್ಯಾಂಕ್ ವಿವರ ಪರಿಶೀಲಿಸಿ.',
  } },
  shift_cancelled: { critical: true, whatsapp: true, text: {
    en: (v) => `ShiftKart: "${v.title}" was cancelled by the business. ${Number(v.paise) > 0 ? `${rs(v.paise)} compensation is on its way.` : ''} This does not affect your score.`,
    hi: (v) => `ShiftKart: बिज़नेस ने "${v.title}" रद्द कर दी। ${Number(v.paise) > 0 ? `${rs(v.paise)} मुआवज़ा आ रहा है।` : ''} इससे आपका स्कोर नहीं घटेगा।`,
    kn: (v) => `ShiftKart: ವ್ಯಾಪಾರ "${v.title}" ರದ್ದುಗೊಳಿಸಿದೆ. ${Number(v.paise) > 0 ? `${rs(v.paise)} ಪರಿಹಾರ ಬರುತ್ತಿದೆ.` : ''} ಇದು ನಿಮ್ಮ ಸ್ಕೋರ್‌ಗೆ ಪರಿಣಾಮ ಬೀರುವುದಿಲ್ಲ.`,
  } },
  turned_away: { critical: true, whatsapp: true, text: {
    en: (v) => `ShiftKart: you were sent home from "${v.title}". You are being paid ${rs(v.paise)} for turning up.`,
    hi: (v) => `ShiftKart: आपको "${v.title}" से वापस भेजा गया। आने के लिए ${rs(v.paise)} दिए जा रहे हैं।`,
    kn: (v) => `ShiftKart: "${v.title}"ನಿಂದ ನಿಮ್ಮನ್ನು ವಾಪಸ್ ಕಳುಹಿಸಲಾಗಿದೆ. ಬಂದಿದ್ದಕ್ಕೆ ${rs(v.paise)} ಪಾವತಿಸಲಾಗುತ್ತಿದೆ.`,
  } },
  appeal_decided: { critical: false, whatsapp: true, text: {
    en: (v) => `ShiftKart: your appeal was ${v.accepted ? 'accepted. The strike is removed.' : 'not accepted.'} ${v.reason}`,
    hi: (v) => `ShiftKart: आपकी अपील ${v.accepted ? 'मंज़ूर हुई। स्ट्राइक हटा दी गई।' : 'मंज़ूर नहीं हुई।'} ${v.reason}`,
    kn: (v) => `ShiftKart: ನಿಮ್ಮ ಮೇಲ್ಮನವಿ ${v.accepted ? 'ಸ್ವೀಕರಿಸಲಾಗಿದೆ. ಸ್ಟ್ರೈಕ್ ತೆಗೆದುಹಾಕಲಾಗಿದೆ.' : 'ಸ್ವೀಕರಿಸಲಾಗಿಲ್ಲ.'} ${v.reason}`,
  } },
  hire_offer: { critical: false, whatsapp: true, text: {
    en: (v) => `ShiftKart: a business you worked for offers you a full-time job (${v.role}). See it in the app. It's free, and you can say no.`,
    hi: (v) => `ShiftKart: जिस बिज़नेस में आपने काम किया, वह आपको पक्की नौकरी (${v.role}) दे रहा है। ऐप में देखें। यह मुफ़्त है, आप मना कर सकते हैं।`,
    kn: (v) => `ShiftKart: ನೀವು ಕೆಲಸ ಮಾಡಿದ ವ್ಯಾಪಾರ ನಿಮಗೆ ಪೂರ್ಣಾವಧಿ ಕೆಲಸ (${v.role}) ನೀಡುತ್ತಿದೆ. ಆ್ಯಪ್‌ನಲ್ಲಿ ನೋಡಿ. ಉಚಿತ, ನೀವು ನಿರಾಕರಿಸಬಹುದು.`,
  } },
  sos_trusted_contact: { critical: true, whatsapp: false, text: {
    en: (v) => `ShiftKart: ${v.name} pressed SOS. Live location for ${v.hours} hours: ${v.link}. Our safety team is alerted. Emergency: 112.`,
    hi: (v) => `ShiftKart: ${v.name} ने SOS दबाया। ${v.hours} घंटे तक लाइव लोकेशन: ${v.link}। हमारी सुरक्षा टीम को खबर है। आपातकाल: 112।`,
    kn: (v) => `ShiftKart: ${v.name} SOS ಒತ್ತಿದ್ದಾರೆ. ${v.hours} ಗಂಟೆ ಲೈವ್ ಸ್ಥಳ: ${v.link}. ನಮ್ಮ ಸುರಕ್ಷತಾ ತಂಡಕ್ಕೆ ತಿಳಿಸಲಾಗಿದೆ. ತುರ್ತು: 112.`,
  } },
  // Business side
  timesheet_pending: { critical: false, whatsapp: true, text: {
    en: (v) => `ShiftKart: ${v.name} checked out of "${v.title}". Approve or dispute the hours within ${v.hours} h, or they're approved automatically.`,
    hi: (v) => `ShiftKart: ${v.name} ने "${v.title}" से चेक-आउट किया। ${v.hours} घंटे में घंटे मंज़ूर या विवादित करें, वरना अपने-आप मंज़ूर होंगे।`,
    kn: (v) => `ShiftKart: ${v.name} "${v.title}"ನಿಂದ ಚೆಕ್-ಔಟ್ ಆಗಿದ್ದಾರೆ. ${v.hours} ಗಂಟೆಯೊಳಗೆ ಅನುಮೋದಿಸಿ, ಇಲ್ಲದಿದ್ದರೆ ಸ್ವಯಂ ಅನುಮೋದನೆ.`,
  } },
  worker_not_confirmed: { critical: false, whatsapp: true, text: {
    en: (v) => `ShiftKart: ${v.count} worker(s) for "${v.title}" at ${v.time} haven't confirmed they're coming. People on the waitlist are on standby.`,
    hi: (v) => `ShiftKart: "${v.title}" (${v.time}) के ${v.count} वर्कर ने आने की पुष्टि नहीं की है। वेटलिस्ट वाले तैयार हैं।`,
    kn: (v) => `ShiftKart: "${v.title}" (${v.time}) ಗೆ ${v.count} ಕೆಲಸಗಾರರು ಬರುವುದನ್ನು ದೃಢಪಡಿಸಿಲ್ಲ. ವೇಟ್‌ಲಿಸ್ಟ್‌ನವರು ಸಿದ್ಧರಿದ್ದಾರೆ.`,
  } },
  worker_cancelled: { critical: false, whatsapp: true, text: {
    en: (v) => `ShiftKart: a worker cancelled "${v.title}". ${v.slot === 'offered' ? 'The place has been offered to the next person on the waitlist.' : 'The place is open again.'}`,
    hi: (v) => `ShiftKart: एक वर्कर ने "${v.title}" रद्द की। ${v.slot === 'offered' ? 'जगह वेटलिस्ट के अगले व्यक्ति को दी गई है।' : 'जगह फिर से खुली है।'}`,
    kn: (v) => `ShiftKart: ಒಬ್ಬ ಕೆಲಸಗಾರ "${v.title}" ರದ್ದುಗೊಳಿಸಿದ್ದಾರೆ. ${v.slot === 'offered' ? 'ಜಾಗ ವೇಟ್‌ಲಿಸ್ಟ್‌ನ ಮುಂದಿನವರಿಗೆ ನೀಡಲಾಗಿದೆ.' : 'ಜಾಗ ಮತ್ತೆ ಖಾಲಿಯಿದೆ.'}`,
  } },
  removal_notice: { critical: true, whatsapp: true, text: {
    en: (v) => `ShiftKart: notice that your account will be closed on ${v.date}. Reasons: ${v.reasons} ${v.hold ? 'Until then you cannot take new shifts. ' : 'You can keep working until then. '}You can reply in the app (Me > Notice).`,
    hi: (v) => `ShiftKart: सूचना: आपका खाता ${v.date} को बंद होगा। कारण: ${v.reasons} ${v.hold ? 'तब तक आप नई शिफ्ट नहीं ले सकते। ' : 'तब तक आप काम कर सकते हैं। '}आप ऐप में जवाब दे सकते हैं (मैं > सूचना)।`,
    kn: (v) => `ShiftKart: ಸೂಚನೆ: ನಿಮ್ಮ ಖಾತೆ ${v.date}ರಂದು ಮುಚ್ಚಲಾಗುತ್ತದೆ. ಕಾರಣಗಳು: ${v.reasons} ${v.hold ? 'ಅಲ್ಲಿಯವರೆಗೆ ಹೊಸ ಶಿಫ್ಟ್ ತೆಗೆದುಕೊಳ್ಳಲಾಗುವುದಿಲ್ಲ. ' : 'ಅಲ್ಲಿಯವರೆಗೆ ನೀವು ಕೆಲಸ ಮಾಡಬಹುದು. '}ಆ್ಯಪ್‌ನಲ್ಲಿ ಉತ್ತರಿಸಬಹುದು (ನಾನು > ಸೂಚನೆ).`,
  } },
  removal_withdrawn: { critical: true, whatsapp: true, text: {
    en: (v) => `ShiftKart: the notice to close your account has been withdrawn. ${v.reason}`,
    hi: (v) => `ShiftKart: आपका खाता बंद करने की सूचना वापस ले ली गई है। ${v.reason}`,
    kn: (v) => `ShiftKart: ನಿಮ್ಮ ಖಾತೆ ಮುಚ್ಚುವ ಸೂಚನೆಯನ್ನು ಹಿಂಪಡೆಯಲಾಗಿದೆ. ${v.reason}`,
  } },
  removal_effective: { critical: true, whatsapp: false, text: {
    en: () => `ShiftKart: your account is now closed, as given in the notice. Money you are owed will still be paid. To complain, contact our grievance officer.`,
    hi: () => `ShiftKart: सूचना के अनुसार आपका खाता अब बंद है। आपका बकाया पैसा फिर भी मिलेगा। शिकायत के लिए हमारे शिकायत अधिकारी से संपर्क करें।`,
    kn: () => `ShiftKart: ಸೂಚನೆಯಂತೆ ನಿಮ್ಮ ಖಾತೆ ಈಗ ಮುಚ್ಚಲಾಗಿದೆ. ನಿಮಗೆ ಬರಬೇಕಾದ ಹಣ ಪಾವತಿಯಾಗುತ್ತದೆ. ದೂರಿಗಾಗಿ ನಮ್ಮ ಕುಂದುಕೊರತೆ ಅಧಿಕಾರಿಯನ್ನು ಸಂಪರ್ಕಿಸಿ.`,
  } },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;

export function render(name: TemplateName, lang: string, vars: Vars): string {
  const t = TEMPLATES[name] as Template;
  const l = (['en', 'hi', 'kn'].includes(lang) ? lang : 'en') as Lang;
  return t.text[l](vars).replace(/\s+/g, ' ').trim();
}
