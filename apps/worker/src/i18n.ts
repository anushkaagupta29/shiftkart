// Worker-facing strings. Hindi is first-class from Phase 2; Kannada arrives in Phase 5 (with native review).
export type Lang = 'en' | 'hi';

const en = {
  chooseLang: 'Choose your language',
  noFees: 'ShiftKart never asks you for money. No fee, no deposit, ever.',
  phoneTitle: 'Your mobile number', sendCode: 'Send code', codeTitle: 'Enter the 6-digit code', verify: 'Continue',
  devShowCode: 'Show code (testing only)', changeNumber: 'Change number',
  consentTitle: 'Before you start', consentAccount: 'Use my mobile number to log in and send me shift updates (needed)',
  consentLocation: 'Use my location only during shifts to check me in', consentFace: 'Use selfies to confirm it is really me at check-in',
  consentDraft: 'Draft notice, pending legal review.', agree: 'I agree, continue',
  setupTitle: 'Get ready to work', stepIdentity: 'Verify identity (DigiLocker)', stepSelfie: 'Take a selfie', stepPayout: 'Add UPI or bank', stepProfile: 'Your skills & area',
  done: 'Done', inReview: 'Our team is checking', start: 'Start',
  verifiedTitle: 'You are verified!', underReview: 'Your account is being checked by our team. We will message you.',
  shifts: 'Shifts', myShifts: 'My shifts', offers: 'Offers',
  perHour: '/hour', total: 'You get', slotsLeft: 'places left', full: 'Full', km: 'km',
  accept: 'Accept shift', joinWaitlist: 'Join waitlist', back: 'Back', cancel: 'Cancel shift', leaveWaitlist: 'Leave waitlist',
  accepted: 'Shift booked! See you there.', noShifts: 'No shifts near you right now. Pull to refresh later.',
  dress: 'Wear', bring: 'Bring', where: 'Where', when: 'When', break: 'unpaid break',
  meal: 'meal', travel: 'travel', notEligible: 'Not for you yet', needs: 'Needs',
  offerTitle: 'A place opened up for you!', acceptOffer: 'Take it', decline: 'No thanks', waiting: 'On waitlist',
  logout: 'Log out', refresh: 'Refresh',
  dlTitle: 'DigiLocker (test mode)', dlNote: 'In the real app this opens DigiLocker. Pick who you are for testing:',
  selfieTitle: 'Selfie', selfieNote: 'Look at the camera in good light. (Test mode: no camera is used.)',
  takeSelfie: 'Take selfie', selfieOther: 'Test: someone else', selfieSpoof: 'Test: photo of a photo',
  upiTitle: 'Where should we pay you?', upi: 'UPI ID', bank: 'Bank account', accountNo: 'Account number', ifsc: 'IFSC code', save: 'Save',
  upiNote: 'Must be in your own name. We send ₹1 to check it.',
  profileTitle: 'Your work', languages: 'Languages you speak', skills: 'Work you can do', radius: 'How far can you travel?', twoWheeler: 'I have a two-wheeler', city: 'City',
  within: 'Within', change: 'change',
  booked: 'Booked', cancelled: 'Cancelled', confirmCancel: 'Cancel this shift? Cancelling late can affect your score.',
};
type Strings = typeof en;

const hi: Strings = {
  chooseLang: 'अपनी भाषा चुनें',
  noFees: 'ShiftKart आपसे कभी पैसे नहीं मांगता। कोई फीस नहीं, कोई डिपॉजिट नहीं।',
  phoneTitle: 'आपका मोबाइल नंबर', sendCode: 'कोड भेजें', codeTitle: '6 अंकों का कोड डालें', verify: 'आगे बढ़ें',
  devShowCode: 'कोड दिखाएं (सिर्फ टेस्ट)', changeNumber: 'नंबर बदलें',
  consentTitle: 'शुरू करने से पहले', consentAccount: 'लॉगिन और शिफ्ट की जानकारी के लिए मेरा मोबाइल नंबर इस्तेमाल करें (ज़रूरी)',
  consentLocation: 'सिर्फ शिफ्ट के समय चेक-इन के लिए मेरी लोकेशन इस्तेमाल करें', consentFace: 'चेक-इन पर मेरी पहचान के लिए सेल्फी इस्तेमाल करें',
  consentDraft: 'ड्राफ्ट सूचना, कानूनी जांच बाकी।', agree: 'मैं सहमत हूं, आगे बढ़ें',
  setupTitle: 'काम के लिए तैयार हों', stepIdentity: 'पहचान सत्यापित करें (DigiLocker)', stepSelfie: 'सेल्फी लें', stepPayout: 'UPI या बैंक जोड़ें', stepProfile: 'आपका काम और इलाका',
  done: 'हो गया', inReview: 'टीम जांच रही है', start: 'शुरू करें',
  verifiedTitle: 'आप सत्यापित हैं!', underReview: 'हमारी टीम आपका खाता जांच रही है। हम आपको मैसेज करेंगे।',
  shifts: 'शिफ्ट', myShifts: 'मेरी शिफ्ट', offers: 'ऑफर',
  perHour: '/घंटा', total: 'आपको मिलेगा', slotsLeft: 'जगह बाकी', full: 'भरा हुआ', km: 'किमी',
  accept: 'शिफ्ट लें', joinWaitlist: 'वेटलिस्ट में जुड़ें', back: 'वापस', cancel: 'शिफ्ट रद्द करें', leaveWaitlist: 'वेटलिस्ट छोड़ें',
  accepted: 'शिफ्ट बुक हो गई! वहां मिलते हैं।', noShifts: 'अभी आपके पास कोई शिफ्ट नहीं है। थोड़ी देर बाद देखें।',
  dress: 'पहनें', bring: 'साथ लाएं', where: 'कहां', when: 'कब', break: 'बिना वेतन ब्रेक',
  meal: 'खाना', travel: 'यात्रा', notEligible: 'अभी आपके लिए नहीं', needs: 'ज़रूरी',
  offerTitle: 'आपके लिए जगह खुली है!', acceptOffer: 'ले लें', decline: 'नहीं चाहिए', waiting: 'वेटलिस्ट में',
  logout: 'लॉग आउट', refresh: 'रिफ्रेश',
  dlTitle: 'DigiLocker (टेस्ट मोड)', dlNote: 'असली ऐप में DigiLocker खुलेगा। टेस्ट के लिए चुनें आप कौन हैं:',
  selfieTitle: 'सेल्फी', selfieNote: 'अच्छी रोशनी में कैमरे की ओर देखें। (टेस्ट मोड: कैमरा नहीं खुलता।)',
  takeSelfie: 'सेल्फी लें', selfieOther: 'टेस्ट: कोई और', selfieSpoof: 'टेस्ट: फोटो की फोटो',
  upiTitle: 'हम आपको कहां पैसे भेजें?', upi: 'UPI ID', bank: 'बैंक खाता', accountNo: 'खाता संख्या', ifsc: 'IFSC कोड', save: 'सेव करें',
  upiNote: 'आपके अपने नाम पर होना चाहिए। जांच के लिए हम ₹1 भेजते हैं।',
  profileTitle: 'आपका काम', languages: 'आप कौन सी भाषाएं बोलते हैं', skills: 'आप कौन सा काम कर सकते हैं', radius: 'आप कितनी दूर जा सकते हैं?', twoWheeler: 'मेरे पास दोपहिया है', city: 'शहर',
  within: 'दूरी', change: 'बदलें',
  booked: 'बुक', cancelled: 'रद्द', confirmCancel: 'यह शिफ्ट रद्द करें? देर से रद्द करने पर आपका स्कोर घट सकता है।',
};

export const STRINGS: Record<Lang, Strings> = { en, hi };
export type T = Strings;
