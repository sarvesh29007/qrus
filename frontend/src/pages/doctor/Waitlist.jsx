import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

/**
 * The doctor's view of the priority queue. It is read-only by design: the
 * queue is drained automatically when a slot is released (decline, cancel or
 * reschedule), and the ranking rule is urgency first, then who joined first.
 */
export default function DoctorWaitlist() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/doctor/waitlist')
      .then((data) => setEntries(data.entries || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner label="Loading your waitlist…" full />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Waitlist for your clinic</h1>
          <p>
            Patients queued for you (or for your specialty). When you decline, cancel or reschedule, the top of this
            queue is booked into the freed slot in the same transaction.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-ghost" to="/doctor/queue">
            Go to queue
          </Link>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {entries.length === 0 ? (
        <p className="empty-note">Nobody is waiting right now. Releasing a slot will show a notice when it is auto-filled.</p>
      ) : (
        entries.map((entry, index) => (
          <article key={entry.id} className="wait-card" style={{ marginBottom: '0.6rem' }}>
            <div className="wait-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                <span className={`queue-rank${index === 0 ? ' is-first' : ''}`}>{entry.position || index + 1}</span>
                <div>
                  <h3>{entry.patient_name}</h3>
                  <div className="muted small">
                    {entry.patient_email}
                    {entry.requested_me ? ' · requested you specifically' : ' · any doctor in your specialty'}
                  </div>
                </div>
              </div>
              <span className={`urgency urgency-${entry.urgency}`}>{entry.urgency}</span>
            </div>

            <p className="muted small" style={{ margin: '0.55rem 0 0' }}>
              {entry.symptoms}
            </p>

            <div className="wait-meta">
              <span>waiting {Math.round(entry.waiting_hours)}h</span>
              <span>joined {new Date(entry.joined_at).toLocaleString()}</span>
              {entry.preferred_date_from && (
                <span>
                  window {entry.preferred_date_from} → {entry.preferred_date_to}
                </span>
              )}
              {entry.preferred_start && (
                <span>
                  time {entry.preferred_start} – {entry.preferred_end}
                </span>
              )}
              <span>expires {entry.expires_at?.slice(0, 10)}</span>
              <StatusBadge status="waiting" />
            </div>
          </article>
        ))
      )}
    </>
  );
}
