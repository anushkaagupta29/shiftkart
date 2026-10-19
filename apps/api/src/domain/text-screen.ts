// Screens free text in shift posts (title, description, dress code, what to bring).
// A hit sends the shift to human review rather than rejecting it outright, since
// keyword lists produce false positives. Lists are a starting point, in English, Hindi and Kannada.

export type ScreenReason = 'discriminatory_language' | 'worker_payment_request' | 'prohibited_work' | 'document_request';

const RULES: { reason: ScreenReason; patterns: RegExp[] }[] = [
  {
    reason: 'discriminatory_language', // BIZ-07
    patterns: [
      /\bfair[\s-]*(skin(ned)?|complexion)?\b/i, /\bgor[ia]\b/i, /\bcaste\b/i, /\breligion\b/i,
      /\b(hindus?|muslims?|christians?|sikhs?|jains?)\s+only\b/i, /\bonly\s+(hindus?|muslims?|christians?|sikhs?|jains?)\b/i,
      /\bno\s+(hindus?|muslims?|christians?|sikhs?|jains?)\b/i, /\b(brahmin|dalit|sc\s*\/\s*st)\b/i,
      /\bonly\s+(boys|girls|men|women|ladies|gents|males?|females?)\b/i, /\b(boys|girls|men|women|ladies|gents)\s+only\b/i,
      /\b(good[\s-]looking|beautiful|handsome|pretty)\b/i, /\byoung\s+(girls|boys|women|men)\b/i,
      /जाति/, /धर्म/, /गोरी|गोरा/, /(सिर्फ|केवल)\s*(लड़कियां|लड़के|महिलाएं|पुरुष)/, /ಜಾತಿ/, /ಧರ್ಮ/,
    ],
  },
  {
    reason: 'worker_payment_request', // BIZ-02
    patterns: [
      /\b(registration|joining|security|uniform|training|processing|id\s*card)\s*(fee|fees|deposit|charges?)\b/i,
      /\bdeposit\b/i, /\badvance\s+(payment|amount)\b/i, /\bpay\s+(us|first|before)\b/i,
      /फीस|शुल्क|जमा\s*राशि|डिपॉजिट/, /ಶುಲ್ಕ|ಠೇವಣಿ/,
    ],
  },
  {
    reason: 'document_request', // BIZ-01
    patterns: [/\b(aadha?ar|pan\s*card|bank\s*passbook|cheque\s*book)\b/i, /आधार|पैन\s*कार्ड|पासबुक/, /ಆಧಾರ್/],
  },
  {
    reason: 'prohibited_work', // BIZ-03
    patterns: [
      /\b(escort|massage|spa\s+therapist|liquor|alcohol|bar\s*girl|dance\s*bar)\b/i,
      /\b(explosives?|fire\s*crackers?|crackers|chemicals?|hazardous|acid|gas\s+cylinders?)\b/i,
      /\bcash\s+(carry|transport|delivery)\b/i, /\b(outstation|other\s+city|out\s+of\s+station|abroad)\b/i,
      /शराब|मसाज/,
    ],
  },
];

export function screenText(...texts: string[]): ScreenReason[] {
  const joined = texts.join('\n');
  return RULES.filter((r) => r.patterns.some((p) => p.test(joined))).map((r) => r.reason);
}
