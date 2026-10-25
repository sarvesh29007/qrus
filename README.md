# Qrus — secure healthcare scheduling

Qrus is a full-stack healthcare booking platform that replaces fragmented phone-based
scheduling with three isolated portals: **patients** find the right specialty and book a
slot, **doctors** run their clinic queue and calendar, and **admins** govern access,
moderation and the audit trail.

Built exactly to the requested stack:

| Layer     | Technology                                                |
| --------- | --------------------------------------------------------- |
| Frontend  | React 18 + Vite, **plain CSS** (no Tailwind/utility libs), native JS |
| Backend   | Node.js + Express                                         |
| Database  | PostgreSQL (plain SQL schema — no Firebase)               |
| Security  | Strict RBAC, immutable audit logging, JWT auth, rate limits |

---

## Feature highlights

- **Symptom → specialty matcher** — free-text symptoms are normalised and scored against a
  224-rule term vocabulary; the top specialties come back ranked with matched terms and a
  triage hint.
- **Double-booking-proof scheduling** — slots are materialised from weekly schedules plus
  per-date overrides; booking runs in one transaction with a row lock, a status guard and
  partial unique indexes, so two requests can never take the same slot (and one patient can
  never hold the same instant twice).
- **Real-time availability** — every book/cancel/reschedule/block publishes a
  `slot_changed` server-sent event; the slot grid subscribes and refreshes itself.
- **Smart waitlist priority queue** — ranked by `urgency DESC, joined_at ASC`; when a slot
  is released (cancellation, decline, reschedule, un-block) the top eligible patient is
  seated **inside the same transaction** (`FOR UPDATE SKIP LOCKED` prevents double-handing).
- **Verified reviews** — only a `completed` appointment unlocks the form, one review per
  appointment, and publishing happens only through admin moderation (which recalculates the
  doctor's public rating).
- **Audit logging** — every authentication, state transition and clinical-record read
  (symptoms, notes) is written to an append-only `audit_logs` table with actor, outcome,
  metadata and request correlation. The table forbids `UPDATE`/`DELETE`.
- **Conversational assistant** — an in-app chat widget handles triage, queue position,
  booking/rescheduling/cancelling, pre-consultation intake and review requests. Intents are
  classified by a deterministic rule tier first; an LLM is consulted only when the rules are
  unsure (and never at all for FAQs), so no PHI leaves the server on the common path.

---

## Repository layout

```
├── database/
│   ├── schema.sql          # tables, indexes, triggers, append-only audit log
│   └── seed.sql            # specialties + symptom vocabulary (idempotent)
├── backend/
│   ├── src/
│   │   ├── config/         # env parsing, pg pool + transaction helpers
│   │   ├── middleware/     # context, authenticate, RBAC, validation, rate limits, errors
│   │   ├── services/       # symptomMatcher, schedulingEngine, waitlistQueue,
│   │   │                   # appointmentStore, audit, eventBus
│   │   ├── controllers/    # auth, matching, patient, doctor, admin
│   │   ├── routes/         # auth, catalog, patient, doctor, admin, events (SSE)
│   │   ├── utils/          # jwt, time (DST-safe zoned time), errors
│   │   ├── app.js          # express assembly
│   │   └── server.js       # bootstrap
│   ├── scripts/            # migrate.js, seed.js, smoke.js, dev-db.js
│   └── tests/              # node:test unit tests (pure logic)
└── frontend/
    └── src/
        ├── api/client.js   # fetch wrapper: bearer auth + transparent refresh
        ├── context/        # AuthContext (session bootstrap, login/register/logout)
        ├── hooks/          # useSlotEvents (SSE via authorized fetch reader)
        ├── components/     # Layout, ProtectedRoute, SlotGrid, SymptomMatcher, ...
        ├── pages/
        │   ├── auth/       # Login, Register
        │   ├── patient/    # Dashboard, FindCare, DoctorDetail, Appointments, Waitlist, Reviews
        │   ├── doctor/     # Dashboard, Queue, Schedule, Waitlist, Reviews, Profile
        │   └── admin/      # Dashboard, Users, Audit, Reviews
        └── styles/         # global.css, components.css, portals.css (plain CSS)
```

---

## Quick start

**Requirements:** Node.js ≥ 18 and a PostgreSQL database (any recent version).

### 1. Database

Either use your own Postgres and set `DATABASE_URL`, or boot the bundled embedded one
(no system Postgres needed):

```bash
cd backend
npm install
npm run dev:db          # embedded PostgreSQL on localhost:5433, data in .tmp-pgdata/
```

### 2. Backend

```bash
cd backend
cp .env.example .env    # then set DATABASE_URL (and JWT_SECRET for anything shared)
# with the embedded DB: DATABASE_URL=postgresql://postgres:postgres@localhost:5433/qrus_utf8
# (dev:db creates that database as UTF8 — the chatbot's replies contain emoji,
#  which a legacy WIN1252 cluster rejects)

npm run migrate         # applies database/schema.sql + seed.sql
npm run seed            # demo accounts, schedules, slots, appointments (idempotent)
npm start               # http://localhost:4000  (npm run dev for --watch)
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev             # http://localhost:5173 (proxies /api to :4000)
```

### Demo credentials (development seed only)

| Role    | Email               | Password       | Notes                                   |
| ------- | ------------------- | -------------- | --------------------------------------- |
| Admin   | `admin@qrus.dev`    | `QrusAdmin!1`  | access, moderation, audit log           |
| Patient | `priya@qrus.dev`    | `QrusPatient!1`| completed visit, reviews, waitlist      |
| Patient | `arjun@qrus.dev`    | `QrusPatient!1`| pending request + own reviews           |
| Doctor  | `dr.meera@qrus.dev` | `QrusDoctor!1` | cardiology, full schedule               |
| Doctor  | `dr.kavya@qrus.dev` | `QrusDoctor!1` | orthopedics (has a pending request)     |

Eight doctor accounts are seeded; see `backend/scripts/seed.js` for the rest.

---

## Verification

```bash
cd backend
npm test          # unit tests: timezone/date math, error envelope (node:test)
npm run smoke     # 48 end-to-end checks against a running server + seeded DB
```

The smoke suite drives the real API through every critical flow: login/refresh, the three
RBAC boundaries (401/403), symptom matching, slot booking, **double-booking rejection**,
the review gate (before-completion blocked, duplicates blocked, foreign appointments
blocked), doctor accept/decline flows, **waitlist auto-fill on cancellation**, the SSE
stream, and admin moderation/suspension/audit reads. It is repeat-safe; note the sign-in
guard allows 8 logins per account per 15 minutes, so leave a gap between full runs.

Frontend:

```bash
cd frontend
npm run build     # production bundle → dist/
```

---

## Architecture notes

### Authentication & RBAC

- Short-lived JWT **access** tokens (15 min) + rotating **refresh** tokens (30 days) stored
  server-side and revocable; the client refreshes transparently on 401.
- `authenticate` **reloads the user from the database on every request**, so a suspension
  or role change takes effect immediately — a stolen token cannot outlive the account.
- Role gates are mounted per router: `/api/patient-*` area requires `patient`, `/api/doctor/*`
  requires `doctor`, `/api/admin/*` requires `admin`. Handlers additionally re-check
  ownership (`loadOwnedAppointment`) so a valid token still cannot read someone else's file.
- Admin accounts cannot be self-registered (absent from the public register schema); they
  are provisioned by another admin.
- Rate limits: 300 req/min general, 8 sign-ins per account per 15 min (credential-stuffing
  guard keyed by email), 10 registrations per hour per IP. Helmet, strict CORS allow-list
  and payload limits are applied globally.

### Symptom matcher (`services/symptomMatcher.js`)

Normalises the complaint into terms, scores each specialty against weighted keyword rules
(224 rules seeded across 14 specialties), returns a ranked list with matched terms, an
analysed/masked term report and a triage hint (routine / soon / emergency).

### Scheduling engine (`services/schedulingEngine.js`)

- `ensureSlotsForDate` expands weekly windows ± overrides into concrete `appointment_slots`
  rows (wall-clock in `APP_TZ`, plus an absolute `starts_at` timestamptz).
- `bookAppointment` runs inside a transaction: lock the slot `FOR UPDATE`, verify status +
  booking policy (30-min lead, 60-day horizon), verify the patient has no appointment at
  that instant, insert — protected by partial unique indexes so a race still fails cleanly
  with `409 CONFLICT`.
- Slots whose time has already passed (or sits inside the lead window) are reported
  `available:false, past:true` so the grid never offers a time the engine will reject.
- Cancel / reschedule / decline release the slot and call `waitlist.fillSlot()` **in the
  same transaction**, then publish `slot_changed`.

### Waitlist (`services/waitlistQueue.js`)

Priority is never stored — it is derived (`urgency DESC, joined_at ASC`) so it cannot drift.
`pickCandidate` locks the top eligible row with `SKIP LOCKED`, checks the patient's
preferences and same-instant conflicts, seats them and audits `waitlist.filled`. A fresh
entry is also tested against already-open slots so patients are not waitlisted for a slot
that is free right now. A periodic admin sweep (`POST /api/admin/waitlist/sweep`) drains
anything missed.

### Chat assistant (`services/chatIntents.js`, `chatController.js`)

Two classification tiers. The **rules** tier is a weighted keyword/regex table covering every
intent the app implements; it runs in-process, costs nothing and never transmits patient text.
The **LLM** tier (`services/llm.service.js`, OpenAI/Gemini-compatible) is consulted only when
the rules come back unsure, and only ever returns `{ intent, entities }` — it cannot invent an
entity the patient did not state, because entity extraction stays with the rules. Clinic FAQs
(hours, fees, parking, documents, emergency warnings) are answered by `chatFaq.js` *before*
classification, so they never touch a provider.

Handlers map intents onto the existing controllers rather than re-implementing them: booking
and cancellation call `schedulingEngine` (so the row lock, lead-time and clash guards still
apply), queue/waitlist reads call the waitlist service, and intake writes to
`pre_consultation_intake`. Every state change audits through the same `audit.service` actions
as the REST endpoints (`appointment.booked`, `appointment.cancelled`, `intake.submitted`,
`review.created`), and reading an intake from the doctor portal audits `intake.viewed`.

Conversation state lives in `chat_sessions.context` (JSONB): which answer is pending, the
slots or appointments last offered, the triage result. That is what lets a bare `1` pick from
a numbered list and `yes` confirm a proposed date.

### API surface (summary)

| Area   | Routes |
| ------ | ------ |
| Auth   | `POST /api/auth/register,login,refresh,logout`, `GET /api/auth/me` |
| Public | `GET /api/specialties`, `GET /api/doctors`, `GET /api/doctors/:id`, `GET /api/doctors/:id/slots?date=`, `POST /api/match/symptoms`, `GET /api/reviews/doctor/:id` |
| Patient| `GET/POST /api/appointments`, `POST /api/appointments/:id/cancel,reschedule`, `GET/POST/DELETE /api/waitlist`, `GET /api/reviews/eligible,mine`, `POST /api/reviews` |
| Doctor | `GET /api/doctor/dashboard`, `GET/PUT/DELETE /api/doctor/schedule`, `POST/DELETE /api/doctor/overrides`, `GET /api/doctor/appointments`, `GET /api/doctor/appointments/:id/intake`, `POST .../accept,decline,complete,no-show,reschedule`, `GET /api/doctor/waitlist,reviews`, `PATCH /api/doctor/profile` |
| Admin  | `GET /api/admin/stats,users,audit-logs,reviews`, `POST /api/admin/users`, `PATCH /api/admin/users/:id/status,role`, `PATCH /api/admin/reviews/:id`, `POST /api/admin/waitlist/sweep` |
| Chat   | `POST /api/chat/sessions`, `GET /api/chat/sessions`, `GET /api/chat/sessions/:id`, `POST /api/chat/sessions/:id/messages`, `POST /api/chat/sessions/:id/close` |
| Stream | `GET /api/events/slots` (SSE `slot_changed`) |

### Data model

`users` · `refresh_tokens` · `specialties` · `symptom_rules` · `doctor_profiles` ·
`doctor_schedules` · `schedule_overrides` · `appointment_slots` · `appointments` ·
`waitlist_entries` · `reviews` · `audit_logs` · `chat_sessions` · `chat_messages` ·
`pre_consultation_intake` — see `database/schema.sql` for the full
definition, including the partial unique indexes that enforce booking invariants and the
trigger that makes `audit_logs` immutable.

---

## Production notes

In production (`NODE_ENV=production`) Express also serves the built React app from
`frontend/dist`, so the whole product is **one origin** — no CORS configuration, SSE works
as-is, and deep links (`/patient/...`, `/doctor/...`, `/admin/...`) fall through to
`index.html` for the client router.

```bash
cd frontend && npm run build        # → frontend/dist
cd ../backend
NODE_ENV=production JWT_SECRET=<64+ random bytes> DATABASE_URL=<postgres://...> npm start
```

Environment knobs added for deployment:

| Variable           | Effect                                                        |
| ------------------ | ------------------------------------------------------------- |
| `TRUST_PROXY=true` | trust one proxy hop so rate limiting sees real client IPs     |
| `DATABASE_SSL`     | `true` forces TLS; an `sslmode=` in `DATABASE_URL` also enables it |
| `DB_SSL_VERIFY`    | `true` verifies the server cert (off by default for private-CA managed Postgres) |

- Set a strong `JWT_SECRET` — the server refuses to boot in production without one.
- Point `DATABASE_URL` at managed Postgres; run `npm run migrate` once per release
  (the files are idempotent).
- A root `Dockerfile` builds the frontend and packages API + SPA in one image
  (release command: `node backend/scripts/migrate.js`).
- Consider `AUDIT_STRICT=true` so a failed audit write fails the medical action itself.
- The demo seed (`npm run seed`) is for development only — do not run it in production.

### Public demo via Cloudflare quick tunnel

The quickest way to share Qrus with others from a dev machine (no account, no domain):

```bash
cd backend && npm run dev:db                       # embedded Postgres on :5433
NODE_ENV=production JWT_SECRET=$(openssl rand -hex 48) PORT=4000 \
  DATABASE_URL='postgresql://postgres:postgres@localhost:5433/qrus' TRUST_PROXY=true \
  node src/server.js                               # app on :4000

tools/cloudflared.exe tunnel --url http://localhost:4000 --no-autoupdate
# → prints a public https://….trycloudflare.com URL
```

The URL lives only while both processes run and changes on every tunnel restart; SSE is
buffered by the free quick tunnel, so live slot updates fall back to the client's 3-second
reconnect loop (every page also refetches after each action). For a permanent deployment,
use the `Dockerfile` on any container host with managed Postgres (Fly.io, Render, ECS…).
