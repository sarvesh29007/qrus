import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';

/** Platform overview: counters, latest audit entries, waitlist maintenance. */
export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await get('/admin/stats'));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runSweep() {
    setSweeping(true);
    setNotice('');
    setError('');
    try {
      const res = await post('/admin/waitlist/sweep', {});
      const matched = res.matched ?? res.filled ?? res.matchedEntries ?? 0;
      setNotice(
        matched
          ? `Sweep complete — ${matched} waitlist entr${matched === 1 ? 'y' : 'ies'} matched into open slots.`
          : 'Sweep complete — no queued patient matched an open slot right now.'
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSweeping(false);
    }
  }

  if (!data && !error) return <Spinner label="Loading platform stats…" full />;

  const s = data?.stats || {};
  const audit = data?.recentAudit || [];

  const tiles = [
    { label: 'Patients', value: s.patients, note: `${s.doctors} doctors on the platform` },
    { label: 'Active appointments', value: s.active_appointments, note: `${s.appointments_today} today`, accent: true },
    { label: 'Completed', value: s.completed_appointments, note: `${s.cancelled_appointments} cancelled` },
    { label: 'In queues', value: s.waiting, note: 'waitlist entries waiting' },
    { label: 'Reviews pending', value: s.pending_reviews, note: `${s.approved_reviews} published`, link: '/admin/reviews' },
    { label: 'Accounts', value: s.total_users, note: `${s.suspended} suspended · ${s.pending_approvals} pending` },
    { label: 'Audit events', value: s.audit_last_24h, note: 'in the last 24 hours', link: '/admin/audit' },
  ];

  return (
    <>
      <div className="welcome-row">
        <div>
          <h1>Admin console</h1>
          <p className="muted">User access, review moderation and the immutable audit trail.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary" to="/admin/users">Manage users</Link>
          <button className="btn btn-ghost" onClick={runSweep} disabled={sweeping}>
            {sweeping ? 'Sweeping…' : 'Run waitlist sweep'}
          </button>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      <section className="grid grid-4 section">
        {tiles.map((tile) => (
          <div key={tile.label} className={`stat-tile${tile.accent ? ' is-accent' : ''}`}>
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{tile.value ?? '—'}</span>
            <span className="stat-note">
              {tile.link ? <Link to={tile.link}>{tile.note}</Link> : tile.note}
            </span>
          </div>
        ))}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Latest audit activity</h2>
          <Link className="btn btn-ghost btn-sm" to="/admin/audit">Open full trail</Link>
        </div>

        <div className="card">
          {audit.length === 0 ? (
            <p className="empty-note">No audit entries yet.</p>
          ) : (
            <div className="recent-audit">
              {audit.map((row) => (
                <div key={row.id} className="audit-line">
                  <span className="al-action">{row.action}</span>
                  <span className="al-actor">
                    {row.actor_name || (row.actor_role === 'system' ? 'system' : `actor #${row.actor_id}`)} ·{' '}
                    {row.entity_type} #{row.entity_id} · {row.outcome}
                  </span>
                  <span className="al-time">{new Date(row.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
