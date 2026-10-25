import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import AppointmentCard from '../../components/AppointmentCard.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

/** Doctor overview: today's list plus the operational counters behind it. */
export default function DoctorDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/doctor/dashboard')
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Spinner label="Loading your dashboard…" full />;

  const { stats, todaysAppointments, today } = data;

  const tiles = [
    { label: 'Today', value: stats.today_count, note: `visits on ${today}`, accent: true },
    { label: 'Pending requests', value: stats.pending_requests, note: 'awaiting your decision' },
    { label: 'Upcoming', value: stats.upcoming, note: 'scheduled ahead' },
    { label: 'Completed', value: stats.completed_this_month, note: 'this month' },
    { label: 'Waitlist', value: stats.waiting, note: 'patients queued for you' },
    { label: 'Rating', value: Number(stats.rating_average || 0).toFixed(1), note: 'approved reviews only' },
  ];

  return (
    <>
      <div className="welcome-row">
        <div>
          <h1>Good day, {user?.fullName?.replace(/^Dr\s+/i, '') || 'doctor'}</h1>
          <p className="muted">Your clinic activity for {today}.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary" to="/doctor/queue">Open patient queue</Link>
          <Link className="btn btn-ghost" to="/doctor/schedule">Edit schedule</Link>
        </div>
      </div>

      <section className="grid grid-4 section">
        {tiles.map((tile) => (
          <div key={tile.label} className={`stat-tile${tile.accent ? ' is-accent' : ''}`}>
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{tile.value}</span>
            <span className="stat-note">{tile.note}</span>
          </div>
        ))}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Today&apos;s appointments</h2>
          <Link className="btn btn-ghost btn-sm" to="/doctor/queue">Full queue</Link>
        </div>

        {todaysAppointments.length === 0 ? (
          <p className="empty-note">
            No confirmed visits today. <Link to="/doctor/queue">Pending requests</Link> may be waiting for a decision.
          </p>
        ) : (
          todaysAppointments.map((a) => (
            <AppointmentCard
              key={a.id}
              appointment={a}
              title={a.patient_name}
              subtitle={`${a.specialty_name} · ${a.patient_email}${a.patient_phone ? ` · ${a.patient_phone}` : ''}`}
            >
              <StatusBadge status={a.status} />
              <Link className="btn btn-secondary btn-sm" to="/doctor/queue">
                Open in queue
              </Link>
            </AppointmentCard>
          ))
        )}
      </section>
    </>
  );
}
