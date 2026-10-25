import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import AppointmentCard from '../../components/AppointmentCard.jsx';
import SymptomMatcher from '../../components/SymptomMatcher.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

export default function PatientDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [upcoming, setUpcoming] = useState([]);
  const [past, setPast] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [eligible, setEligible] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [up, ps, wl, rv] = await Promise.all([
        get('/appointments?view=upcoming&limit=5'),
        get('/appointments?view=past&limit=50'),
        get('/waitlist'),
        get('/reviews/eligible'),
      ]);
      setUpcoming(up.appointments || []);
      setPast(ps.appointments || []);
      setWaitlist((wl.entries || []).filter((e) => e.status === 'waiting'));
      setEligible(rv.appointments || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const completed = past.filter((a) => a.status === 'completed');

  if (loading) return <Spinner label="Loading your overview…" full />;

  return (
    <>
      <div className="welcome-row">
        <div>
          <h1>Hello, {user?.fullName?.split(' ')[0] || 'there'}</h1>
          <p className="muted">Here is your care at a glance.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary" to="/patient/find">Book an appointment</Link>
          <Link className="btn btn-ghost" to="/patient/waitlist">Join a waitlist</Link>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

      <section className="grid grid-4 section">
        <div className="stat-tile is-accent">
          <span className="stat-label">Upcoming visits</span>
          <span className="stat-value">{upcoming.length}</span>
          <span className="stat-note">next: {upcoming[0] ? `${upcoming[0].scheduled_date} ${upcoming[0].scheduled_time}` : '—'}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Completed</span>
          <span className="stat-value">{completed.length}</span>
          <span className="stat-note">all-time consultations</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Waitlists</span>
          <span className="stat-value">{waitlist.length}</span>
          <span className="stat-note">{waitlist.length ? 'queue positions held' : 'nothing pending'}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Reviews to write</span>
          <span className="stat-value">{eligible.length}</span>
          <span className="stat-note">completed visits, not yet reviewed</span>
        </div>
      </section>

      <div className="detail-grid section">
        <section className="card">
          <div className="card-head section-head">
            <h2>Next appointments</h2>
            <Link className="btn btn-ghost btn-sm" to="/patient/appointments">View all</Link>
          </div>

          {upcoming.length === 0 ? (
            <p className="empty-note">
              Nothing booked yet. <Link to="/patient/find">Find a doctor</Link> or{' '}
              <Link to="/patient/waitlist">join a waitlist</Link>.
            </p>
          ) : (
            upcoming.slice(0, 3).map((a) => (
              <AppointmentCard
                key={a.id}
                appointment={a}
                title={a.doctor_name}
                subtitle={`${a.specialty_name} · ${a.clinic_name || '—'}${a.city ? ` · ${a.city}` : ''}`}
                showSymptoms={false}
              >
                <Link className="btn btn-secondary btn-sm" to="/patient/appointments">
                  Manage
                </Link>
              </AppointmentCard>
            ))
          )}
        </section>

        <aside>
          <SymptomMatcher onPickSpecialty={(s) => navigate(`/patient/find?specialtyId=${s.id}`)} />

          {eligible.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <div className="card-head">
                <h2>How was your visit?</h2>
                <p className="muted">
                  You have {eligible.length} completed visit{eligible.length === 1 ? '' : 's'} waiting for a review.
                </p>
              </div>
              <Link className="btn btn-secondary" to="/patient/reviews">Write a verified review</Link>
            </div>
          )}

          {waitlist.length > 0 && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <div className="card-head">
                <h2>Waitlist status</h2>
              </div>
              <ul className="timeline">
                {waitlist.map((e) => (
                  <li key={e.id}>
                    <span className="tl-action">{e.doctor_name || e.specialty_name}</span>
                    <span className="tl-meta">
                      position #{e.position} · {e.urgency}
                    </span>
                    <StatusBadge status={e.status} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
