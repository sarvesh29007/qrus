'use strict';

/**
 * Admin-editable FAQ — answered from this list, never by the LLM.
 *
 * Requirement: "Handle standard queries (clinic hours, fees, parking) using
 * predefined responses to avoid unnecessary API calls to the LLM."
 *
 * So `match()` runs *before* intent classification. Every reply is a fixed
 * template with a few {tokens}; no user input is ever interpolated into a
 * reply, so prompt injection cannot reach another patient's answer or make the
 * bot speak for the clinic.
 */

const FAQ = [
  {
    id: 'identity',
    // No bare "what are you": it substring-matches "what are your clinic
    // hours?" and steals the hours answer.
    keywords: [
      'what is your name', "what's your name", 'who are you',
      'are you human', 'are you a robot', 'are you a bot', 'your name',
    ],
    reply:
      'I am the Qrus assistant. I handle appointments, queues, waitlists, symptom triage, the pre-visit intake form and reviews, ' +
      'plus practical questions like clinic hours, fees and parking.\n' +
      'Anything I cannot settle here, the front desk can sort out during clinic hours.',
  },
  {
    id: 'services',
    keywords: [
      'mri', 'x-ray', 'xray', 'ct scan', 'ultrasound', 'blood test', 'lab test',
      'scan', 'facilities', 'what do you treat', 'which specialties',
      'physiotherapy', 'vaccination',
    ],
    reply:
      'Qrus runs outpatient clinics across 14 specialties — General Medicine, Cardiology, ' +
      'Dermatology, Neurology, Orthopedics, Pediatrics, Mental Health, Gastroenterology, ' +
      'Respiratory, Gynecology, Eye Care, ENT, Endocrinology and Urology.\n' +
      'Imaging and lab tests (X-ray, ultrasound, blood work) are ordered by the doctor during ' +
      'your consultation, so the right test gets booked for your symptoms.\n' +
      'Open Find care to see which doctors are in today, or tell me your symptoms and I will point ' +
      'you to the right specialty.',
  },
  {
    id: 'account_help',
    keywords: [
      'password', 'forgot my password', 'reset my password', 'cannot log in',
      'cannot login', "can't log in", 'login problem', 'sign in problem', 'account locked',
      'not able to login', 'otp',
    ],
    reply:
      'For sign-in trouble:\n' +
      '• Check you are using the email address the clinic registered for you\n' +
      '• New doctor accounts must be activated by an administrator before the first sign-in\n' +
      '• Password resets are done by the front desk so a clinical account is never opened by mistake\n' +
      'Tell me your registered email and the front desk will send a reset link during clinic hours.',
  },
  {
    id: 'clinic_hours',
    keywords: [
      'clinic hours', 'opening hours', 'open today', 'what time do you open',
      'when do you open', 'when are you open', 'are you open', 'what time do you close',
      'closing time', 'timings', 'your timings', 'time open', 'operating hours',
      'office hours', 'schedule of clinic', 'open on sunday', 'open on saturday',
    ],
    reply:
      'Qrus clinic hours:\n' +
      '• Monday–Friday: 08:00 – 18:00\n' +
      '• Saturday: 08:00 – 13:00\n' +
      '• Sunday: emergency care only\n' +
      'Individual doctor schedules can differ — open a doctor’s profile to see their exact slots.',
  },
  {
    id: 'fees',
    keywords: [
      'how much is a consultation', 'how much for a consultation', 'how much for a consult',
      'consultation fee', 'consultation fees', 'consultation charge', 'consultation price',
      'what does it cost', 'what do you charge', 'your rates', 'fees', 'fee',
      'how much does it cost', 'cost', 'price', 'charges', 'how much charge', 'pricing',
    ],
    reply:
      'Consultation fees are set by each doctor and shown on their profile before you book, so you always see the price first.\n' +
      'Open Find care → a doctor card, and the fee is listed next to their rating and next available slot. There are no booking fees on top of it.',
  },
  {
    id: 'parking',
    keywords: [
      'parking', 'park my car', 'car park', 'where to park', 'valet', 'bike parking',
    ],
    reply:
      'Parking:\n' +
      '• Free basement parking for patients, entry from Gate 2\n' +
      '• Valet parking on weekdays 08:00–14:00\n' +
      '• Two-wheeler bay at the east entrance\n' +
      'Bring your token to reception for validation.',
  },
  {
    id: 'location',
    keywords: [
      'where are you', 'address', 'location', 'how do i get there', 'directions',
      'nearest landmark', 'which branch', 'map',
    ],
    reply:
      'Qrus is at 4th Floor, Sunrise Medical Plaza, MG Road.\n' +
      'Landmark: opposite the metro station, Gate 2 entrance.\n' +
      'Each doctor’s clinic name and city are shown on their profile card — open Find care to check the exact room.',
  },
  {
    id: 'insurance',
    keywords: [
      'insurance', 'covered by insurance', 'cashless', 'claim', 'tpa', 'policy cover',
    ],
    reply:
      'Insurance and cashless claims are handled per doctor and per policy, so we can’t confirm coverage from here.\n' +
      'Please check the “Insurance” note on the doctor’s profile, or ask the clinic desk at reception with your policy card.',
  },
  {
    id: 'documents',
    keywords: [
      'what to bring', 'documents', 'id proof', 'what should i carry', 'papers',
      'previous reports',
    ],
    reply:
      'For your visit please bring:\n' +
      '• A government photo ID\n' +
      '• Your appointment confirmation\n' +
      '• Any previous reports or prescriptions for this complaint\n' +
      'You can also add your history and current medicines in this chat before the visit — the doctor sees them instantly.',
  },
  {
    id: 'emergency',
    keywords: [
      'emergency', 'ambulance', 'chest pain now', 'cannot breathe', 'unconscious',
      'severe bleeding', '911', 'life threatening', 'dying',
    ],
    reply:
      '⚠️ This looks like an emergency. Do not wait for a chat reply.\n' +
      'Call your local emergency number or go to the nearest emergency department immediately.\n' +
      'Qrus chat is not monitored for emergencies.',
  },
  {
    id: 'cancellation_policy',
    keywords: [
      'cancellation policy', 'refund', 'cancel policy', 'late cancellation', 'no show fee',
    ],
    reply:
      'You can cancel or reschedule from Appointments, or right here in the chat.\n' +
      'Cancelling at least 30 minutes before the slot is free of charge; later cancellations count as a no-show.\n' +
      'Need to change one now? Just tell me which appointment.',
  },
  {
    id: 'records_privacy',
    keywords: [
      'my data', 'privacy', 'who can see my records', 'is my data safe', 'hipaa',
      'confidential', 'gdpr',
    ],
    reply:
      'Your records are private to you and the doctor you are seeing.\n' +
      'Every time a record is opened, that read is written to an immutable audit log with the viewer and time.\n' +
      'Chat messages are stored against your account only and are never sent to another patient.',
  },
  {
    id: 'human',
    keywords: [
      'talk to a human', 'speak to a human', 'speak to someone', 'real person', 'real human',
      'human being', 'customer care', 'contact number', 'call the clinic', 'call me back',
      'support',
    ],
    reply:
      'You can reach the clinic desk at the front office during clinic hours, or ask for a call-back from the reception team.\n' +
      'For anything clinical, the fastest route is to book a slot — I can set that up right here.',
  },
];

/** Index keywords once; longest keyword first so "consultation fee" beats "fee". */
const INDEX = FAQ.flatMap((entry) =>
  entry.keywords.map((keyword) => ({ id: entry.id, reply: entry.reply, keyword }))
).sort((a, b) => b.keyword.length - a.keyword.length);

/**
 * @param {string} text lowercased user message
 * @returns {{ id: string, reply: string } | null}
 */
function match(text) {
  const haystack = String(text || '').toLowerCase();
  // Longest-keyword-first scan: a message that names an emergency should land
  // on the emergency reply even if it also mentions fees.
  for (const entry of INDEX) {
    if (haystack.includes(entry.keyword)) return { id: entry.id, reply: entry.reply };
  }
  return null;
}

module.exports = { match, FAQ };
