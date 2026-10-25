-- =============================================================================
-- QRUS — Secure Healthcare Scheduling Platform
-- PostgreSQL 14+ schema  (idempotent: safe to re-run)
--
-- Design notes
--   * All identifiers are BIGSERIAL; every resource is still authorised
--     server-side (never by trusting a client-supplied id).
--   * Timestamps are TIMESTAMPTZ. Wall-clock clinic times (TIME) are stored
--     alongside so a clinic day is stable regardless of the viewer's timezone.
--   * Double-booking is prevented twice over: an application-level row lock
--     inside the booking transaction AND partial unique indexes.
--   * Every medical action writes to audit_logs (see backend audit service).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 1. USERS  (RBAC principals)
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  full_name      TEXT        NOT NULL,
  phone          TEXT,
  role           TEXT        NOT NULL DEFAULT 'patient'
                 CHECK (role IN ('patient', 'doctor', 'admin')),
  -- 'pending' = registered doctor awaiting admin approval
  status         TEXT        NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'pending', 'suspended')),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (LOWER(email));
CREATE INDEX        IF NOT EXISTS users_role_idx    ON users (role, status);

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 2. SPECIALTIES  +  SYMPTOM RULES (symptom-to-specialty matcher vocabulary)
-- =============================================================================
CREATE TABLE IF NOT EXISTS specialties (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL UNIQUE,
  description  TEXT        NOT NULL DEFAULT '',
  icon         TEXT        NOT NULL DEFAULT 'stethoscope',
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- term      : normalised lowercase phrase ("chest pain", "ringing in ears")
-- weight    : 0-10 routing strength for this term -> specialty
-- is_active : lets an admin disable a term without deleting audit history
CREATE TABLE IF NOT EXISTS symptom_rules (
  id            BIGSERIAL PRIMARY KEY,
  specialty_id  BIGINT      NOT NULL REFERENCES specialties (id) ON DELETE CASCADE,
  term          TEXT        NOT NULL,
  weight        NUMERIC(4,2) NOT NULL DEFAULT 3.0
                CHECK (weight > 0 AND weight <= 10),
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- expression unique index: one row per (specialty, normalised term)
CREATE UNIQUE INDEX IF NOT EXISTS symptom_rules_term_uidx
  ON symptom_rules (specialty_id, lower(term));
CREATE INDEX IF NOT EXISTS symptom_rules_active_idx
  ON symptom_rules (lower(term)) WHERE is_active;

-- =============================================================================
-- 3. DOCTOR PROFILES
-- =============================================================================
CREATE TABLE IF NOT EXISTS doctor_profiles (
  user_id             BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  specialty_id        BIGINT      NOT NULL REFERENCES specialties (id),
  license_number      TEXT        NOT NULL UNIQUE,
  bio                 TEXT        NOT NULL DEFAULT '',
  years_experience    INT         NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  consultation_fee    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0),
  clinic_name         TEXT,
  city                TEXT,
  languages           TEXT[]      NOT NULL DEFAULT '{}',
  accepting_new_patients BOOLEAN   NOT NULL DEFAULT TRUE,
  rating_avg          NUMERIC(3,2) NOT NULL DEFAULT 0 CHECK (rating_avg >= 0 AND rating_avg <= 5),
  rating_count        INT         NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doctor_profiles_specialty_idx ON doctor_profiles (specialty_id);

DROP TRIGGER IF EXISTS doctor_profiles_updated_at ON doctor_profiles;
CREATE TRIGGER doctor_profiles_updated_at BEFORE UPDATE ON doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 4. RECURRING SCHEDULES + DATE OVERRIDES  (what the slot engine reads)
-- =============================================================================
-- weekday: 0 = Sunday ... 6 = Saturday (matches JS Date#getDay())
CREATE TABLE IF NOT EXISTS doctor_schedules (
  id            BIGSERIAL PRIMARY KEY,
  doctor_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  weekday       SMALLINT    NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time    TIME        NOT NULL,
  end_time      TIME        NOT NULL,
  slot_minutes  INT         NOT NULL DEFAULT 20 CHECK (slot_minutes BETWEEN 5 AND 240),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  UNIQUE (doctor_id, weekday, start_time)
);

CREATE INDEX IF NOT EXISTS doctor_schedules_doctor_idx ON doctor_schedules (doctor_id);

-- One row per doctor per date.
--   is_available = FALSE, times NULL            -> block the whole day (leave/holiday)
--   is_available = FALSE, times set              -> carve that window out of the day
--   is_available = TRUE , times set              -> add an extra window that day
CREATE TABLE IF NOT EXISTS schedule_overrides (
  id            BIGSERIAL PRIMARY KEY,
  doctor_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  override_date DATE        NOT NULL,
  is_available  BOOLEAN     NOT NULL,
  start_time    TIME,
  end_time      TIME,
  reason        TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time),
  UNIQUE (doctor_id, override_date, start_time)
);

CREATE INDEX IF NOT EXISTS schedule_overrides_date_idx ON schedule_overrides (doctor_id, override_date);

-- =============================================================================
-- 5. APPOINTMENT SLOTS  (materialised by the scheduling engine)
-- =============================================================================
-- The unit of availability. slot_date/starts_at are clinic wall-clock,
-- starts_at_tz is the absolute instant used for ordering and comparisons.
CREATE TABLE IF NOT EXISTS appointment_slots (
  id             BIGSERIAL PRIMARY KEY,
  doctor_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slot_date      DATE        NOT NULL,
  starts_at      TIME        NOT NULL,
  ends_at        TIME        NOT NULL,
  starts_at_tz   TIMESTAMPTZ NOT NULL,
  ends_at_tz     TIMESTAMPTZ NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'booked', 'blocked')),
  specialty_id   BIGINT      REFERENCES specialties (id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (doctor_id, slot_date, starts_at)
);

CREATE INDEX IF NOT EXISTS appointment_slots_day_idx  ON appointment_slots (doctor_id, slot_date, starts_at);
CREATE INDEX IF NOT EXISTS appointment_slots_open_idx ON appointment_slots (doctor_id, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS appointment_slots_time_idx ON appointment_slots (starts_at_tz) WHERE status = 'open';

-- =============================================================================
-- 6. APPOINTMENTS  (the core clinical-encounter record)
-- =============================================================================
-- Lifecycle:
--   pending  -> scheduled -> completed
--   pending|scheduled -> cancelled_by_patient | cancelled_by_doctor | rescheduled
--   scheduled -> no_show
-- 'pending' and 'scheduled' occupy the slot; nothing else does.
CREATE TABLE IF NOT EXISTS appointments (
  id                   BIGSERIAL PRIMARY KEY,
  patient_id           BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  doctor_id            BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slot_id              BIGINT      NOT NULL REFERENCES appointment_slots (id) ON DELETE RESTRICT,
  specialty_id         BIGINT      NOT NULL REFERENCES specialties (id),
  status               TEXT        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'scheduled', 'completed', 'no_show',
                                         'cancelled_by_patient', 'cancelled_by_doctor', 'rescheduled')),
  reason               TEXT        NOT NULL DEFAULT '',
  symptoms             TEXT        NOT NULL DEFAULT '',
  doctor_note          TEXT,
  -- denormalised from the slot so reporting/audit never needs a join
  scheduled_for        TIMESTAMPTZ NOT NULL,
  scheduled_date       DATE        NOT NULL,
  scheduled_time       TIME        NOT NULL,
  rescheduled_from_id  BIGINT      REFERENCES appointments (id) ON DELETE SET NULL,
  reschedule_count     INT         NOT NULL DEFAULT 0,
  accepted_at          TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  cancellation_reason  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The invariants that make double-booking impossible:
CREATE UNIQUE INDEX IF NOT EXISTS appt_slot_taken_uidx
  ON appointments (slot_id) WHERE status IN ('pending', 'scheduled');
CREATE UNIQUE INDEX IF NOT EXISTS appt_doctor_clash_uidx
  ON appointments (doctor_id, scheduled_for) WHERE status IN ('pending', 'scheduled');
CREATE UNIQUE INDEX IF NOT EXISTS appt_patient_clash_uidx
  ON appointments (patient_id, scheduled_for) WHERE status IN ('pending', 'scheduled');

CREATE INDEX IF NOT EXISTS appt_patient_idx  ON appointments (patient_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS appt_doctor_idx   ON appointments (doctor_id, scheduled_for);
CREATE INDEX IF NOT EXISTS appt_status_idx   ON appointments (status, scheduled_for);
CREATE INDEX IF NOT EXISTS appt_specialty_idx ON appointments (specialty_id);

DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 7. WAITLIST  (priority queue)
-- =============================================================================
-- doctor_id NULL  => "any qualified doctor in specialty_id"
-- Priority is derived, never stored, so it cannot drift:
--   (urgency rank DESC, joined_at ASC)  — urgent first, FIFO inside a band.
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id                    BIGSERIAL PRIMARY KEY,
  patient_id            BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  doctor_id             BIGINT      REFERENCES users (id) ON DELETE CASCADE,
  specialty_id          BIGINT      NOT NULL REFERENCES specialties (id),
  symptoms              TEXT        NOT NULL,
  urgency               TEXT        NOT NULL DEFAULT 'routine'
                        CHECK (urgency IN ('routine', 'soon', 'urgent')),
  preferred_date_from   DATE,
  preferred_date_to     DATE,
  preferred_start       TIME,
  preferred_end         TIME,
  status                TEXT        NOT NULL DEFAULT 'waiting'
                        CHECK (status IN ('waiting', 'matched', 'cancelled', 'expired')),
  matched_appointment_id BIGINT     REFERENCES appointments (id) ON DELETE SET NULL,
  matched_at            TIMESTAMPTZ,
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (doctor_id IS NOT NULL OR specialty_id IS NOT NULL),
  CHECK (preferred_date_from IS NULL OR preferred_date_to IS NULL
         OR preferred_date_to >= preferred_date_from)
);

-- one live queue entry per patient per target
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_active_uidx
  ON waitlist_entries (patient_id, COALESCE(doctor_id, 0), specialty_id)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS waitlist_queue_idx
  ON waitlist_entries (doctor_id, status, joined_at);
CREATE INDEX IF NOT EXISTS waitlist_specialty_idx
  ON waitlist_entries (specialty_id, status, joined_at);
CREATE INDEX IF NOT EXISTS waitlist_status_idx ON waitlist_entries (status, expires_at);

DROP TRIGGER IF EXISTS waitlist_updated_at ON waitlist_entries;
CREATE TRIGGER waitlist_updated_at BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 8. REVIEWS  (verified: only after a COMPLETED appointment)
-- =============================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id               BIGSERIAL PRIMARY KEY,
  doctor_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  patient_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  appointment_id   BIGINT      NOT NULL UNIQUE REFERENCES appointments (id) ON DELETE CASCADE,
  rating           SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment          TEXT        NOT NULL DEFAULT '',
  status           TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
  moderation_note  TEXT,
  moderated_by     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  moderated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reviews_doctor_idx  ON reviews (doctor_id, status);
CREATE INDEX IF NOT EXISTS reviews_status_idx  ON reviews (status, created_at DESC);

DROP TRIGGER IF EXISTS reviews_updated_at ON reviews;
CREATE TRIGGER reviews_updated_at BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 9. AUDIT LOG  (append-only trail of every medical / privileged action)
-- =============================================================================
-- actor_id is SET NULL rather than cascaded so history survives account
-- deletion; patient_id records whose care record was touched.
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  actor_role   TEXT        NOT NULL DEFAULT 'system',
  action       TEXT        NOT NULL,
  entity_type  TEXT        NOT NULL,
  entity_id    TEXT,
  patient_id   BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  outcome      TEXT        NOT NULL DEFAULT 'success'
               CHECK (outcome IN ('success', 'failure')),
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address   INET,
  user_agent   TEXT,
  request_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_created_idx  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx   ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_patient_idx  ON audit_logs (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_metadata_idx ON audit_logs USING GIN (metadata);

-- Append-only: no UPDATE, no DELETE (defence in depth at the DB layer)
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- =============================================================================
-- 10. REFRESH TOKENS  (rotating, hashed, revocable)
-- =============================================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  replaced_by   BIGINT      REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_sweep_idx ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;

-- =============================================================================
-- 11. CHAT  (Smart Healthcare Chatbot: sessions + immutable message log)
-- =============================================================================
-- One row per conversation. `context` holds the dialog state the bot needs to
-- carry across turns (pending intent, chosen doctor, offered slot ids) so the
-- API stays stateless and a second tab cannot corrupt an in-flight booking.
-- It must never store clinical text: PHI lives in chat_messages / intake only.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed')),
  subject         TEXT        NOT NULL DEFAULT '',
  context         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_intent     TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_idx
  ON chat_sessions (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_open_idx
  ON chat_sessions (user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS chat_sessions_context_idx
  ON chat_sessions USING GIN (context);

DROP TRIGGER IF EXISTS chat_sessions_updated_at ON chat_sessions;
CREATE TRIGGER chat_sessions_updated_at BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- sender 'user' | 'bot' | 'system'. `intent` records which handler produced a
-- bot turn, so a bad LLM classification is diagnosable without reading PHI.
-- metadata is sanitised by the audit sanitizer before it is written.
CREATE TABLE IF NOT EXISTS chat_messages (
  id           BIGSERIAL PRIMARY KEY,
  session_id   BIGINT      NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sender       TEXT        NOT NULL CHECK (sender IN ('user', 'bot', 'system')),
  content      TEXT        NOT NULL,
  intent       TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx
  ON chat_messages (session_id, id);
CREATE INDEX IF NOT EXISTS chat_messages_user_idx
  ON chat_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_intent_idx
  ON chat_messages (intent) WHERE intent IS NOT NULL;

-- =============================================================================
-- 12. PRE-CONSULTATION INTAKE  (collected in chat, read by the doctor)
-- =============================================================================
-- Exactly one intake form per appointment (UNIQUE), owned by the appointment's
-- patient and denormalised with doctor_id so the doctor portal can list intake
-- without walking back through appointments.
CREATE TABLE IF NOT EXISTS pre_consultation_intake (
  id                  BIGSERIAL PRIMARY KEY,
  appointment_id      BIGINT      NOT NULL UNIQUE REFERENCES appointments (id) ON DELETE CASCADE,
  patient_id          BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  doctor_id           BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  medical_history     TEXT        NOT NULL DEFAULT '',
  current_medications TEXT        NOT NULL DEFAULT '',
  -- 'pending' = the bot has prompted but not yet received an answer
  status              TEXT        NOT NULL DEFAULT 'submitted'
                      CHECK (status IN ('pending', 'submitted')),
  submitted_via       TEXT        NOT NULL DEFAULT 'chat'
                      CHECK (submitted_via IN ('chat', 'portal')),
  submitted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intake_appointment_idx ON pre_consultation_intake (appointment_id);
CREATE INDEX IF NOT EXISTS intake_patient_idx     ON pre_consultation_intake (patient_id, created_at DESC);
-- The doctor's "who still owes me intake forms" query.
CREATE INDEX IF NOT EXISTS intake_doctor_idx
  ON pre_consultation_intake (doctor_id, status) WHERE status = 'pending';

DROP TRIGGER IF EXISTS intake_updated_at ON pre_consultation_intake;
CREATE TRIGGER intake_updated_at BEFORE UPDATE ON pre_consultation_intake
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
