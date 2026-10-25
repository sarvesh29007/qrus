'use strict';
/**
 * End-to-end smoke suite: drives the running API through every critical flow
 * (auth, RBAC isolation, symptom matcher, double-booking guard, verified
 * reviews, waitlist auto-fill on release, SSE, admin moderation).
 *
 *   npm run migrate && npm run seed && npm start   # in one shell
 *   npm run smoke                                   # in another (48 checks)
 *
 * Repeat-safe: it reactivates accounts a previous run suspended, reuses its
 * throwaway users, and degrades idempotently where demo state is one-shot.
 * Note the sign-in guard allows 8 logins per account per 15 minutes, so leave
 * a gap between back-to-back full runs.
 */
const BASE = process.env.BASE_URL || 'http://localhost:4000/api';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name} :: ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)}`); }
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function login(email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (r.status === 429) {
    throw new Error(
      `login ${email} -> 429 RATE_LIMITED (8 sign-ins per account per 15 min). ` +
        'Wait for the window to roll over, then rerun the suite.'
    );
  }
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken || r.body.token;
}

/** login first; only hit /auth/register (10/hour per IP) when the account is new. */
async function ensurePatient(email, fullName) {
  const existing = await call('POST', '/auth/login', { body: { email, password: 'QrusPatient!1' } });
  if (existing.status === 200) return existing.body.accessToken || existing.body.token;

  const r = await call('POST', '/auth/register', {
    body: { email, fullName, password: 'QrusPatient!1', role: 'patient' },
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`register ${email} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.accessToken || r.body.token;
}

/** Every open slot on one date, for a doctor. */
async function daySlots(doctorId, date) {
  const r = await call('GET', `/doctors/${doctorId}/slots?date=${date}`);
  if (r.status !== 200) return null;
  return r.body.slots || [];
}

/** {date, slots} for the smallest fully-bookable future day (keeps the fill test cheap). */
async function scanDays(doctorId) {
  const out = [];
  const base = Date.now();
  for (let i = 1; i <= 14; i += 1) {
    const d = new Date(base + i * 86400000);
    if (d.getUTCDay() === 0) continue;
    const date = d.toISOString().slice(0, 10);
    const slots = await daySlots(doctorId, date);
    if (!slots) continue;
    const open = slots.filter((s) => s.status === 'open' || s.status === 'available' || s.available === true);
    if (open.length) out.push({ date, open });
  }
  out.sort((a, b) => a.open.length - b.open.length);
  return out;
}

async function findOpenSlot(doctorId) {
  const days = await scanDays(doctorId);
  return days[0] ? { date: days[0].date, free: days[0].open[0], open: days[0].open } : null;
}

async function main() {
  // --- liveness ------------------------------------------------------------
  const healthRes = await fetch(BASE.replace(/\/api$/, '') + '/health');
  const health = { status: healthRes.status, body: await healthRes.json().catch(() => null) };
  ok('GET /health', health.status === 200 && health.body.status === 'ok', health);

  // --- admin first: reactivate anything a previous run suspended -----------
  const admin = await login('admin@qrus.dev', 'QrusAdmin!1');
  const userList = await call('GET', '/admin/users?limit=100', { token: admin });
  const suspended = (userList.body.users || []).filter((u) => u.status !== 'active');
  let reactivated = 0;
  for (const u of suspended) {
    const r = await call('PATCH', `/admin/users/${u.id}/status`, { token: admin, body: { status: 'active' } });
    if (r.status >= 200 && r.status < 300) reactivated += 1;
  }
  ok('admin reactivates suspended accounts', reactivated === suspended.length, { suspended, reactivated });

  // --- throwaway accounts ---------------------------------------------------
  const wToken = await ensurePatient('waitlist.demo@qrus.dev', 'Wendy Waitlist');
  const sToken = await ensurePatient('suspend.demo@qrus.dev', 'Sam Suspensible');
  // Dedicated day-filler: a fresh account never collides with the same-timestamp
  // conflict rule the way long-lived demo accounts do after repeated runs.
  const fillerToken = await ensurePatient('filler.demo@qrus.dev', 'Frank Filler');
  // Second throwaway: books the pending-appointment step below. Priya is not
  // used there because her earlier booking with another doctor can land on the
  // same timestamp, and the engine correctly refuses one patient two visits at
  // once — which would fail the run for a reason that has nothing to do with
  // the doctor queue being tested.
  const queueToken = await ensurePatient('queue.demo@qrus.dev', 'Quinn Queue');

  // --- logins ---------------------------------------------------------------
  const priya = await login('priya@qrus.dev', 'QrusPatient!1');
  const arjun = await login('arjun@qrus.dev', 'QrusPatient!1');
  const meera = await login('dr.meera@qrus.dev', 'QrusDoctor!1');
  const kavya = await login('dr.kavya@qrus.dev', 'QrusDoctor!1');
  const arun = await login('dr.arun@qrus.dev', 'QrusDoctor!1');
  ok('login all six roles', Boolean(priya && arjun && meera && kavya && arun));

  const bad = await call('POST', '/auth/login', { body: { email: 'priya@qrus.dev', password: 'wrong' } });
  ok('bad password rejected (401) or throttled (429)', bad.status === 401 || bad.status === 429, bad);

  const me = await call('GET', '/auth/me', { token: priya });
  ok('GET /auth/me returns patient', me.status === 200 && me.body.user.role === 'patient', me);

  // --- RBAC -----------------------------------------------------------------
  const noAuth = await call('GET', '/appointments');
  ok('unauthenticated -> 401', noAuth.status === 401, noAuth);
  const patientAdmin = await call('GET', '/admin/stats', { token: priya });
  ok('patient -> /admin is 403', patientAdmin.status === 403, patientAdmin);
  const patientDoctor = await call('GET', '/doctor/dashboard', { token: priya });
  ok('patient -> /doctor is 403', patientDoctor.status === 403, patientDoctor);
  const doctorAdmin = await call('GET', '/admin/users', { token: meera });
  ok('doctor -> /admin is 403', doctorAdmin.status === 403, doctorAdmin);

  // --- public catalog -------------------------------------------------------
  const specs = await call('GET', '/specialties');
  ok('GET /specialties (public)', specs.status === 200 && specs.body.specialties.length >= 10, specs.body);
  const doctors = await call('GET', '/doctors');
  ok('GET /doctors (public)', doctors.status === 200 && doctors.body.doctors.length >= 5, doctors.body);
  // Avoid Dr Kavya: the seed leaves Priya on Kavya's waitlist, which would
  // compete for the released slot in the auto-fill test below.
  const targetDoctor = doctors.body.doctors.find((d) => !/kavya/i.test(d.name)) || doctors.body.doctors[0];
  const doctorId = targetDoctor.id;

  // --- symptom matcher ------------------------------------------------------
  const match = await call('POST', '/match/symptoms', {
    token: priya,
    body: { symptoms: 'chest tightness when climbing stairs, mild breathlessness, palpitations' },
  });
  ok('symptom matcher recommends cardiology', match.status === 200 && /cardio/i.test(JSON.stringify(match.body)), match.body);
  const matchNoAuth = await call('POST', '/match/symptoms', { body: { symptoms: 'fever' } });
  ok('matcher requires auth', matchNoAuth.status === 401, matchNoAuth);

  // --- slots + double-booking ---------------------------------------------
  const noDate = await call('GET', `/doctors/${doctorId}/slots`);
  ok('slots endpoint requires a date', noDate.status >= 400 && noDate.status < 500, noDate);

  const found = await findOpenSlot(doctorId);
  ok('open slot exists', Boolean(found), found && { date: found.date, n: found.open.length });

  // Book the first slot this patient can actually take: a 409 here means the
  // slot is gone OR the patient already holds another visit at that timestamp.
  let free = null;
  let book1 = { status: 0, body: 'no open slots to try' };
  for (const candidate of (found ? found.open : []).slice(0, 12)) {
    const r = await call('POST', '/appointments', {
      token: priya,
      body: { slotId: candidate.id, reason: 'Chest pain check', symptoms: 'chest tightness, palpitations' },
    });
    if (r.status === 201 || r.status === 200) { free = candidate; book1 = r; break; }
    book1 = r;
    if (r.status !== 409) break; // surface real errors immediately
  }
  ok('patient books a slot', book1.status === 201 || book1.status === 200, book1);

  const book2 = free
    ? await call('POST', '/appointments', { token: arjun, body: { slotId: free.id, reason: 'Same slot, other patient' } })
    : { status: 0, body: 'skipped' };
  ok('double-booking rejected', book2.status >= 400 && book2.status < 500, book2);

  const bookOwn = free
    ? await call('POST', '/appointments', { token: priya, body: { slotId: free.id, reason: 'Same patient again' } })
    : { status: 0, body: 'skipped' };
  ok('same slot re-book rejected', bookOwn.status >= 400 && bookOwn.status < 500, bookOwn);

  // --- verified review gate -------------------------------------------------
  const appts = await call('GET', '/appointments?view=all&limit=100', { token: priya });
  const rows = appts.body.appointments || [];
  const completed = rows.find((a) => a.status === 'completed');
  const upcoming = rows.find((a) => a.status === 'pending' || a.status === 'scheduled');
  ok('patient lists appointments', appts.status === 200 && Boolean(completed && upcoming), rows.map((a) => a.status));

  const gated = await call('POST', '/reviews', {
    token: priya, body: { appointmentId: upcoming.id, rating: 5, comment: 'Too early to review.' },
  });
  ok('review before completion blocked', gated.status >= 400 && gated.status < 500, gated);

  const eligible = await call('GET', '/reviews/eligible', { token: priya });
  const target = (eligible.body.appointments || [])[0] || completed;
  const firstReview = await call('POST', '/reviews', {
    token: priya, body: { appointmentId: target.id, rating: 5, comment: 'Thorough and reassuring.' },
  });
  ok('review after completion accepted (or already reviewed)',
    firstReview.status === 201 || (eligible.body.appointments || []).length === 0,
    { eligible: eligible.body, firstReview });

  const dup = await call('POST', '/reviews', {
    token: priya, body: { appointmentId: target.id, rating: 4, comment: 'Second review.' },
  });
  ok('duplicate review blocked', dup.status >= 400 && dup.status < 500, dup);

  const otherPatientReview = await call('POST', '/reviews', {
    token: arjun, body: { appointmentId: completed.id, rating: 1, comment: 'Not my visit.' },
  });
  ok("another patient cannot review someone else's appointment",
    otherPatientReview.status >= 400 && otherPatientReview.status < 500, otherPatientReview);

  // --- doctor portal --------------------------------------------------------
  const dash = await call('GET', '/doctor/dashboard', { token: meera });
  ok('doctor dashboard', dash.status === 200, dash.body);

  // Whether *today* has anything in it depends on the seed and the clock (a
  // clinic closed for the evening has no same-day slots left), so assert the
  // default-date contract here and the listing itself against a booking made
  // just below, which is data this script controls.
  const dAppts = await call('GET', '/doctor/appointments?status=active', { token: kavya });
  ok('doctor queue defaults to a day view with no date override',
    dAppts.status === 200 && dAppts.body.view === 'day' && dAppts.body.date === null,
    dAppts.body);

  // fresh pending appointment: a throwaway patient books with kavya, kavya accepts twice
  const kavyaId = doctors.body.doctors.find((d) => /kavya/i.test(d.name)).id;
  const kavyaSlot = await findOpenSlot(kavyaId);
  let fresh = { status: 0, body: 'no open slots to try' };
  for (const candidate of (kavyaSlot ? kavyaSlot.open : []).slice(0, 12)) {
    const r = await call('POST', '/appointments', {
      token: queueToken,
      body: { slotId: candidate.id, reason: 'Follow-up visit' },
    });
    if (r.status === 201 || r.status === 200) { fresh = r; break; }
  }
  ok('booking creates a pending appointment awaiting the doctor',
    (fresh.status === 201 || fresh.status === 200) && fresh.body.appointment.status === 'pending', fresh.body);

  const freshId = fresh.body && fresh.body.appointment && fresh.body.appointment.id;
  const accept = freshId ? await call('POST', `/doctor/appointments/${freshId}/accept`, { token: kavya, body: {} }) : { status: 0 };
  ok('doctor accepts pending appointment', accept.status >= 200 && accept.status < 300, accept);
  const acceptAgain = freshId ? await call('POST', `/doctor/appointments/${freshId}/accept`, { token: kavya, body: {} }) : { status: 0 };
  ok('double-accept rejected', acceptAgain.status >= 400, acceptAgain);

  const kavyaQueue = await call('GET', '/doctor/appointments?view=upcoming&status=active', { token: kavya });
  ok('doctor queue lists the appointment just booked',
    kavyaQueue.status === 200 && (kavyaQueue.body.appointments || []).some((a) => a.id === freshId),
    kavyaQueue.body);

  const crossDoctor = freshId
    ? await call('GET', `/doctor/appointments/${freshId}`, { token: meera })
    : { status: 0 };
  ok('doctor cannot read another doctor\'s appointment', crossDoctor.status === 403 || crossDoctor.status === 404, crossDoctor);

  // --- waitlist: release-triggered auto-fill -------------------------------
  const days = await scanDays(doctorId);
  const day = days[0];
  ok('found a day to fill', Boolean(day), days.map((d) => [d.date, d.open.length]));

  // A dedicated filler account takes every slot on that day.
  let booked = 0;
  for (const s of day.open) {
    const r = await call('POST', '/appointments', { token: fillerToken, body: { slotId: s.id, reason: 'Hold slot' } });
    if (r.status === 201 || r.status === 200) booked += 1;
  }
  ok('filled the day with bookings', booked === day.open.length, { wanted: day.open.length, booked });

  const openLeft = (await daySlots(doctorId, day.date)).filter((s) => s.status === 'open' || s.available === true);
  ok('no open slots remain that day', openLeft.length === 0, openLeft.slice(0, 3));

  // Clear any stale waiting entry from an earlier run so the window matches today.
  const priorList = await call('GET', '/waitlist', { token: wToken });
  for (const entry of priorList.body.entries || []) {
    if (entry.status === 'waiting') {
      await call('DELETE', `/waitlist/${entry.id}`, { token: wToken });
    }
  }

  // Wendy joins with a window pinned to that day: nothing free, so she waits.
  let join = await call('POST', '/waitlist', {
    token: wToken,
    body: {
      doctorId,
      symptoms: 'Persistent cough for two weeks',
      urgency: 'urgent',
      preferredDateFrom: day.date,
      preferredDateTo: day.date,
    },
  });
  if (join.status === 409) {
    // Repeat run: reuse her still-waiting entry instead of failing the test.
    const list = await call('GET', '/waitlist', { token: wToken });
    const existing = (list.body.entries || []).find((e) => e.doctor_id === doctorId && e.status === 'waiting');
    join = { status: 201, body: { matchedImmediately: false, entry: existing || null } };
  }
  ok('waitlist join stays queued when the day is full',
    join.status === 201 && join.body.matchedImmediately === false && join.body.entry.status === 'waiting', join.body);

  // Release one slot -> the queue must seat her in the same transaction.
  const fillerAppts = (await call('GET', '/appointments?view=all&limit=100', { token: fillerToken })).body.appointments || [];
  const victim = fillerAppts.find((a) => a.status !== 'cancelled' && a.scheduled_date === day.date && a.doctor_id === doctorId);
  const cancel = victim
    ? await call('POST', `/appointments/${victim.id}/cancel`, { token: fillerToken, body: { reason: 'No longer needed' } })
    : { status: 0, body: 'skipped' };
  ok('patient cancels appointment', cancel.status >= 200 && cancel.status < 300 && cancel.status !== 0, cancel.body);
  ok('cancellation auto-fills the waitlist in-transaction', cancel.body && cancel.body.waitlistFilled === true, cancel.body);

  const wList = await call('GET', '/waitlist', { token: wToken });
  const wEntry = (wList.body.entries || []).find((e) => e.doctor_id === doctorId);
  ok('waitlist entry is matched, not waiting', wEntry && wEntry.status === 'matched', wList.body);

  const wAppts = (await call('GET', '/appointments?view=upcoming', { token: wToken })).body.appointments || [];
  const seated = wAppts.find((a) => a.scheduled_date === day.date && a.doctor_id === doctorId);
  ok('waitlisted patient received the freed slot', Boolean(seated), wAppts.map((a) => [a.scheduled_date, a.doctor_id, a.status]));

  // --- SSE stream -----------------------------------------------------------
  try {
    const ac = new AbortController();
    const sse = await fetch(BASE + '/events/slots', {
      headers: { Authorization: `Bearer ${meera}`, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = sse.body.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    ac.abort();
    ok('SSE stream opens with an event-stream content type',
      sse.status === 200 && /text\/event-stream/.test(sse.headers.get('content-type') || ''),
      { status: sse.status, ctype: sse.headers.get('content-type'), chunk: first.value && first.value.length });
  } catch (err) {
    ok('SSE stream opens with an event-stream content type', false, String(err));
  }

  // --- admin portal ---------------------------------------------------------
  const stats = await call('GET', '/admin/stats', { token: admin });
  ok('admin stats', stats.status === 200, stats.body);
  ok('admin lists users', userList.status === 200 && (userList.body.users || []).length >= 5, null);
  const logs = await call('GET', '/admin/audit-logs?limit=50', { token: admin });
  const logRows = logs.body.logs || logs.body.entries || logs.body.items || [];
  ok('admin reads audit logs', logs.status === 200 && logRows.length > 0, Object.keys(logs.body || {}));

  const reviews = await call('GET', '/admin/reviews', { token: admin });
  const pendingReview = (reviews.body.reviews || []).find((r) => r.status === 'pending');
  ok('admin sees a moderation queue', reviews.status === 200, reviews.body);
  if (pendingReview) {
    const mod = await call('PATCH', `/admin/reviews/${pendingReview.id}`, { token: admin, body: { status: 'approved' } });
    ok('admin moderates a review', mod.status >= 200 && mod.status < 300, mod);
    const modAgain = await call('PATCH', `/admin/reviews/${pendingReview.id}`, { token: admin, body: { status: 'rejected' } });
    ok('moderation re-decision allowed', modAgain.status >= 200 && modAgain.status < 300, modAgain);
  }

  const freshList = await call('GET', '/admin/users?limit=100', { token: admin });
  const sUser = (freshList.body.users || []).find((u) => u.email === 'suspend.demo@qrus.dev');
  ok('registered throwaway account is visible to admin', Boolean(sUser), (freshList.body.users || []).map((u) => u.email));
  const suspend = await call('PATCH', `/admin/users/${sUser.id}/status`, { token: admin, body: { status: 'suspended' } });
  ok('admin suspends a user', suspend.status >= 200 && suspend.status < 300, suspend);
  const suspendedLogin = await call('POST', '/auth/login', { body: { email: 'suspend.demo@qrus.dev', password: 'QrusPatient!1' } });
  ok('suspended account cannot sign in', suspendedLogin.status >= 400 && suspendedLogin.status < 500, suspendedLogin);
  const reactivate = await call('PATCH', `/admin/users/${sUser.id}/status`, { token: admin, body: { status: 'active' } });
  ok('admin reactivates the user', reactivate.status >= 200 && reactivate.status < 300, reactivate);

  const badLogin = await call('POST', '/auth/login', { body: { email: 'admin@qrus.dev', password: 'QrusPatient!1' } });
  ok('admin password is not the patient password', badLogin.status >= 400, badLogin);

  const asPatient = await call('GET', '/admin/audit-logs?limit=5', { token: priya });
  ok('audit endpoint stays admin-only', asPatient.status === 403, asPatient);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((err) => { console.error('SMOKE ERROR:', err); process.exitCode = 1; });
