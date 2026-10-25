import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import AppointmentCard from '../../components/AppointmentCard.jsx';
import SlotGrid from '../../components/SlotGrid.jsx';

const TABS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'all', label: 'All' },
];

export default function MyAppointments() {
  const [view, setView] = useState('upcoming');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);

  const [cancelling, setCancelling] = useState(null); // appointment being cancelled
  const [cancelReason, setCancelReason] = useState('');
  const [rescheduling, setRescheduling] = useState(null); // appointment being moved
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await get(`/appointments?view=${view}&limit=50`);
      setRows(data.appointments || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmCancel(appointment) {
    setBusy(true);
    setError('');
    try {
      const res = await post(`/appointments/${appointment.id}/cancel`, { reason: cancelReason.trim() });
      if (res.waitlistFilled) {
        setNotice({ kind: 'success', text: 'Your slot was released — a waitlisted patient has been booked into it automatically.' });
      } else {
        setNotice({ kind: 'success', text: 'Appointment cancelled. The slot is open for other patients again.' });
      }
      setCancelling(null);
      setCancelReason('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmReschedule(appointment, slot) {
    setBusy(true);
    setError('');
    try {
      const res = await post(`/appointments/${appointment.id}/reschedule`, { slotId: slot.id });
      setNotice({
        kind: 'success',
        text: `Moved to ${slot.date} at ${slot.start}.${
          res.waitlistFilled ? ' Your previous slot was auto-filled from the waitlist.' : ''
        }`,
      });
      setRescheduling(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My appointments</h1>
          <p>Cancel or reschedule a visit, and review a doctor once the appointment is completed.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary" to="/patient/find">Book new</Link>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Appointment range">
        {TABS.map((tab) => (
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

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      {loading ? (
        <Spinner label="Loading appointments…" full />
      ) : rows.length === 0 ? (
        <p className="empty-note">
          No {view === 'all' ? '' : view} appointments. <Link to="/patient/find">Find a doctor</Link> to book one.
        </p>
      ) : (
        rows.map((a) => (
          <div key={a.id}>
            <AppointmentCard
              appointment={a}
              title={a.doctor_name}
              subtitle={`${a.specialty_name} · ${a.clinic_name || '—'}${a.city ? ` · ${a.city}` : ''}${
                a.review_id ? ` · review ${a.review_status}` : ''
              }`}
            >
              {(a.status === 'pending' || a.status === 'scheduled') && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setRescheduling(rescheduling === a.id ? null : a.id);
                      setCancelling(null);
                    }}
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      setCancelling(cancelling === a.id ? null : a.id);
                      setRescheduling(null);
                    }}
                  >
                    Cancel
                  </button>
                </>
              )}
              {a.status === 'completed' && !a.review_id && (
                <Link className="btn btn-primary btn-sm" to="/patient/reviews">
                  Leave a verified review
                </Link>
              )}
              {a.status === 'completed' && a.review_id && (
                <span className="muted small">Review {a.review_status}</span>
              )}
            </AppointmentCard>

            {cancelling === a.id && (
              <div className="confirm-strip" style={{ marginTop: '0.4rem' }}>
                <span>Cancel this appointment? The slot is released immediately.</span>
                <input
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Reason (optional, 300 chars)"
                  maxLength={300}
                  aria-label="Cancellation reason"
                />
                <button className="btn btn-danger btn-sm" onClick={() => confirmCancel(a)} disabled={busy}>
                  {busy ? 'Cancelling…' : 'Yes, cancel it'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setCancelling(null)} disabled={busy}>
                  Keep it
                </button>
              </div>
            )}

            {rescheduling === a.id && (
              <div className="card" style={{ marginTop: '0.4rem' }}>
                <div className="card-head">
                  <h2>Move appointment #{a.id}</h2>
                  <p className="muted">Pick a new slot — your current one is only released once the move succeeds.</p>
                </div>
                <SlotGrid doctorId={a.doctor_id} onSelect={(slot) => confirmReschedule(a, slot)} disabled={busy} />
                <div className="page-actions" style={{ marginTop: '0.8rem' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRescheduling(null)} disabled={busy}>
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
