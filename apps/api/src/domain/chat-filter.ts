// Screens chat messages between a worker and a business (MSG-02/03/04, BIZ-01/02).
//  deliver  – sent as is, or with phone numbers / emails masked
//  warn     – sent, with a safety card shown to the recipient (e.g. someone asks for ID documents)
//  block    – not sent; the sender is told why and the recipient sees a warning that someone tried

export type FilterResult = { action: 'deliver' | 'warn' | 'block'; body: string; flags: string[] };

const MAPS_HOSTS = /^(maps\.google\.[a-z.]+|www\.google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|www\.openstreetmap\.org|osm\.org)/i;
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s]+|[a-z0-9-]+\.(?:com|in|net|org|ly|io|co|me|xyz|app|link|site|info|biz|online|top|click)(?:\/[^\s]*)?)/gi;
const UPI_RE = /\b[a-z0-9._-]{2,}@(?:ok[a-z]+|ybl|ibl|axl|paytm|upi|apl|icici|sbi|hdfc[a-z]*|axis[a-z]*|kotak|pnb|boi|barodampay|yesbank|idfcbank|jupiteraxis|freecharge|airtel|jio|indus|federal|rbl|aubank|waicici|wasbi|wahdfcbank|waaxis)\b/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z.]{2,}/gi;
const PHONE_RE = /(?:\+?91[\s-]*)?(?:[6-9][\s-]*(?:\d[\s-]*){9})/g;
const SPELLED_DIGITS = /\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)[\s,.-]*){7,}/gi;
const PAYMENT = [
  /\b(pay|send|transfer|deposit|give)\b.{0,30}(₹|rs\.?|rupees?|inr|\d{2,})/i,
  /(₹|rs\.?|rupees?)\s?\d+.{0,30}\b(fee|deposit|advance|registration|charges?|security|uniform|commission|cut)\b/i,
  /\b(registration|joining|security|uniform|training|processing)\s*(fee|fees|deposit|charges?|amount)\b/i,
  /\b(gpay|google pay|phonepe|phone pe|paytm|bhim)\b/i,
  /पैसे\s*(भेज|दे|जमा)|फीस|जमा\s*राशि|एडवांस|कमीशन|ಹಣ\s*ಕಳುಹಿಸಿ|ಶುಲ್ಕ/,
];
const OTP_REQ = /\b(otp|one time password|verification code)\b.{0,40}\b(share|send|tell|give|forward|bata)\b|\b(share|send|tell|give|forward)\b.{0,40}\b(otp|code)\b|ओटीपी|OTP\s*बता/i;
const DOCS = /\b(aadha?ar|pan\s*card|passbook|bank\s*statement|cheque|atm\s*card|debit\s*card|card\s*number|cvv|pin\s*number)\b|आधार|पैन\s*कार्ड|पासबुक|ಆಧಾರ್/i;
// A short starter list; ops extend it (Phase 5). Matched as whole words.
const ABUSE = /\b(bastard|bitch|whore|slut|fuck(?:er|ing)?|motherfucker|chutiya|madarchod|behenchod|bhosdi\w*|randi|harami|kutti|saala\s*kutta)\b|मादरचोद|बहनचोद|रंडी|हरामी|चूतिया/i;

export function filterMessage(text: string): FilterResult {
  const flags: string[] = [];
  let body = text.trim().slice(0, 1000);
  if (!body) return { action: 'block', body: '', flags: ['empty'] };

  if (ABUSE.test(body)) flags.push('abuse');
  if (OTP_REQ.test(body)) flags.push('otp_request');
  if (UPI_RE.test(body)) flags.push('upi_id');
  if (PAYMENT.some((p) => p.test(body))) flags.push('payment_request');
  const links = [...body.matchAll(URL_RE)].map((m) => m[0]).filter((u) => !MAPS_HOSTS.test(u.replace(/^https?:\/\//i, '')) && !EMAIL_RE.test(u));
  EMAIL_RE.lastIndex = 0;
  if (links.length) flags.push('link');
  if (flags.length) return { action: 'block', body, flags };

  if (DOCS.test(body)) flags.push('document_request');
  const beforeMask = body;
  body = body.replace(EMAIL_RE, '[email hidden]').replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 10 ? '[number hidden]' : m)).replace(SPELLED_DIGITS, '[number hidden]');
  if (body !== beforeMask) flags.push('contact_masked');
  return { action: flags.includes('document_request') ? 'warn' : 'deliver', body, flags };
}
