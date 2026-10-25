import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import AppointmentCard from '../../components/AppointmentCard.jsx';
import SlotGrid from '../../components/SlotGrid.jsx';

const VIEWS = [
  { id: 'day', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'all', label: 'All' },
];

const STATUS_FILTER = [
  { id: '', label: 'Any status' },
  { id: 'active', label: 'Pending + scheduled' },
  { id: 'pending', label: 'Pending only' },
  { id: 'scheduled', label: 'Scheduled only' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'no_show', label: 'No-shows' },
];

const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Doctor's clinical queue: filter by day/upcoming/all, open a patient's
 * symptoms, then accept, decline, reschedule, complete or mark no-show.
 * Every transition reloads the list and surfaces the waitlist auto-fill
 * notice when the released slot was handed to a queued patient.
 */
export default function DoctorQueue() {
  const { user } = useAuth();
  const [view, setView] = useState('day');
  const [date, setDate] = useState(iso(new Date()));
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);

  // per-row interaction state
  const [busyId, setBusyId] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const [completing, setCompleting] = useState(null);
  const [note, setNote] = useState('');
  const [rescheduling, setRescheduling] = useState(null);

  // Pre-consultation intake: fetched on demand because reading a patient's
  // clinical detail is audited server-side, so it must be a deliberate click.
  const [intakeFor, setIntakeFor] = useState(null);
  const [intake, setIntake] = useState(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeError, setIntakeError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ view, limit: '100' });
      if (view === 'day') params.set('date', date);
      if (status) params.set('status', status);
      const data = await get(`/doctor/appointments?${params.toString()}`);
      setRows(data.appointments || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [view, date, status]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleIntake(appointment) {
    if (intakeFor === appointment.id) {
      setIntakeFor(null);
      return;
    }
    setIntakeFor(appointment.id);
    setIntake(null);
    setIntakeError('');
    setIntakeLoading(true);
    try {
      const data = await get(`/doctor/appointments/${appointment.id}/intake`);
      setIntake(data.intake);
    } catch (err) {
      setIntakeError(
        err.status === 404 ? 'The patient has not filled in the intake form yet.' : err.message
      );
    } finally {
      setIntakeLoading(false);
    }
  }

  function resetInline() {
    setDeclining(null);
    setDeclineReason('');
    setCompleting(null);
    setNote('');
    setRescheduling(null);
  }

  async function act(appointment, action, body, successText) {
    setBusyId(appointment.id);
    setError('');
    try {
      const res = await post(`/doctor/appointments/${appointment.id}/${action}`, body || {});
      if (res.waitlistFilled) {
        setNotice({
          kind: 'success',
          text: `${successText} The released slot was offered to the top of your waitlist and booked instantly.`,
        });
      } else {
        setNotice({ kind: 'success', text: successText });
      }
      resetInline();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = rows.filter((a) => a.status === 'pending').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Patient queue</h1>
          <p>
            Opening a patient&apos;s record is audited. Accept or decline requests, move visits, and close them out
            after the consultation.
          </p>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Queue range">
        {VIEWS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={`tab${view === tab.id ? ' is-active' : ''}`}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="filter-bar">
        {view === 'day' && (
          <div className="filter-field">
            <label htmlFor="queueDate">Date</label>
            <input id="queueDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        )}
        <div className="filter-field">
          <label htmlFor="queueStatus">Status</label>
          <select id="queueStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTER.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {pendingCount > 0 && (
          <span className="confirm-strip" style={{ marginBottom: 0 }}>
            {pendingCount} request{pendingCount === 1 ? '' : 's'} awaiting your decision
          </span>
        )}
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {loading ? (
        <Spinner label="Loading queue…" full />
      ) : rows.length === 0 ? (
        <p className="empty-note">No appointments match this view.</p>
      ) : (
        rows.map((a) => (
          <div key={a.id}>
            <AppointmentCard
              appointment={a}
              title={a.patient_name}
              subtitle={`${a.specialty_name} · requested ${new Date(a.created_at).toLocaleDateString()}${
                a.reschedule_count ? ` · rescheduled ${a.reschedule_count}×` : ''
              }`}
            >
              <span className="muted small">
                {a.patient_email}
                {a.patient_phone ? ` · ${a.patient_phone}` : ''}
              </span>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-expanded={intakeFor === a.id}
                onClick={() => toggleIntake(a)}
              >
                {intakeFor === a.id ? 'Hide intake' : 'Pre-consultation intake'}
              </button>

              {a.status === 'pending' && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busyId === a.id}
                    onClick={() => act(a, 'accept', {}, 'Appointment accepted — the patient sees it as confirmed.')}
                  >
                    {busyId === a.id ? 'Working…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      setDeclining(declining === a.id ? null : a.id);
                      setDeclineReason('');
                      setCompleting(null);
                      setRescheduling(null);
                    }}
                  >
                    Decline
                  </button>
                </>
              )}

              {a.status === 'scheduled' && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      setCompleting(completing === a.id ? null : a.id);
                      setNote(a.doctor_note || '');
                      setDeclining(null);
                      setRescheduling(null);
                    }}
                  >
                    Mark completed
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setRescheduling(rescheduling === a.id ? null : a.id);
                      setDeclining(null);
                      setCompleting(null);
                    }}
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busyId === a.id}
                    onClick={() => act(a, 'no-show', {}, 'Marked as a no-show.')}
                  >
                    No-show
                  </button>
                </>
              )}

              {a.status === 'completed' && a.review_id && (
                <span className="muted small">Patient review: {a.review_status} · {'★'.repeat(a.review_rating)}</span>
              )}
            </AppointmentCard>

            {intakeFor === a.id && (
              <div className="card" style={{ marginTop: '0.4rem' }}>
                <div className="card-head">
                  <h2>Pre-consultation intake</h2>
                  <p className="muted">
                    Provided by {a.patient_name} through the Qrus assistant before the visit.
                  </p>
                </div>
                {intakeLoading ? (
                  <Spinner label="Loading intake…" />
                ) : intakeError ? (
                  <p className="empty-note">{intakeError}</p>
                ) : intake ? (
                  <>
                    <div className="form-field">
                      <label htmlFor={`hist-${a.id}`}>Medical history</label>
                      <p id={`hist-${a.id}`}>{intake.medical_history || 'Not provided'}</p>
                    </div>
                    <div className="form-field">
                      <label htmlFor={`meds-${a.id}`}>Current medications</label>
                      <p id={`meds-${a.id}`}>{intake.current_medications || 'Not provided'}</p>
                    </div>
                    <p className="muted small">
                      Submitted {new Date(intake.submitted_at || intake.updated_at).toLocaleString()}
                      {intake.submitted_via === 'chat' ? ' · via chat assistant' : ''}
                    </p>
                  </>
                ) : null}
              </div>
            )}

            {declining === a.id && (
              <div className="confirm-strip" style={{ marginTop: '0.4rem' }}>
                <span>Decline and release the slot to the waitlist?</span>
                <input
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder="Reason shared with the patient (300 chars)"
                  maxLength={300}
                  aria-label="Decline reason"
                />
                <button
                  className="btn btn-danger btn-sm"
                  disabled={busyId === a.id}
                  onClick={() =>
                    act(a, 'decline', { reason: declineReason.trim() }, 'Request declined and the slot released.')
                  }
                >
                  Decline
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setDeclining(null)} disabled={busyId === a.id}>
                  Keep
                </button>
              </div>
            )}

            {completing === a.id && (
              <div className="card" style={{ marginTop: '0.4rem' }}>
                <div className="card-head">
                  <h2>Close visit with {a.patient_name}</h2>
                  <p className="muted">Completion unlocks the patient&apos;s verified review for this appointment.</p>
                </div>
                <div className="form-field">
                  <label htmlFor={`note-${a.id}`}>Clinical note</label>
                  <textarea
                    id={`note-${a.id}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="Diagnosis, advice, follow-up…"
                  />
                </div>
                <div className="page-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={busyId === a.id}
                    onClick={() => act(a, 'complete', { note: note.trim() }, 'Appointment completed.')}
                  >
                    {busyId === a.id ? 'Saving…' : 'Mark completed'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setCompleting(null)} disabled={busyId === a.id}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {rescheduling === a.id && (
              <div className="card" style={{ marginTop: '0.4rem' }}>
                <div className="card-head">
                  <h2>Reschedule {a.patient_name}</h2>
                  <p className="muted">Pick a new slot — the old one is released (and auto-filled) in the same transaction.</p>
                </div>
                <SlotGrid
                  doctorId={user.id}
                  onSelect={(slot) =>
                    act(
                      a,
                      'reschedule',
                      { slotId: slot.id, reason: `Moved to ${slot.date} ${slot.start}` },
                      `Appointment moved to ${slot.date} ${slot.start}.`
                    )
                  }
                  disabled={busyId === a.id}
                />
                <div className="page-actions" style={{ marginTop: '0.8rem' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRescheduling(null)} disabled={busyId === a.id}>
                    Stop rescheduling
                  </button>
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}
