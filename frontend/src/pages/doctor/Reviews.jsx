import { useCallback, useEffect, useState } from 'react';
import { get } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'approved', label: 'Published' },
  { id: 'pending', label: 'In moderation' },
  { id: 'rejected', label: 'Not published' },
];

/** The doctor's own reviews plus the approved-rating breakdown. */
export default function DoctorReviews() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = status ? `?status=${status}` : '';
      setData(await get(`/doctor/reviews${params}`));
    } catch (err) {
      setError(err.message);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data && !error) return <Spinner label="Loading reviews…" full />;

  const stats = data?.stats || { approved: 0, pending: 0, rejected: 0, average: 0 };
  const reviews = data?.reviews || [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Patient reviews</h1>
          <p>
            Only patients with a completed appointment can write one, and each visit yields exactly one review. Only
            administrator-approved reviews affect your public rating.
          </p>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

      <section className="grid grid-4 section">
        <div className="stat-tile is-accent">
          <span className="stat-label">Public rating</span>
          <span className="stat-value">{Number(stats.average || 0).toFixed(1)}</span>
          <span className="stat-note">from approved reviews</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Published</span>
          <span className="stat-value">{stats.approved}</span>
          <span className="stat-note">visible to patients</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">In moderation</span>
          <span className="stat-value">{stats.pending}</span>
          <span className="stat-note">awaiting an admin</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">Not published</span>
          <span className="stat-value">{stats.rejected}</span>
          <span className="stat-note">declined by moderation</span>
        </div>
      </section>

      <div className="tabs" role="tablist" aria-label="Review filter">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={status === filter.id}
            className={`tab${status === filter.id ? ' is-active' : ''}`}
            onClick={() => setStatus(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {!data ? null : reviews.length === 0 ? (
        <p className="empty-note">No reviews in this category yet.</p>
      ) : (
        reviews.map((review) => (
          <article key={review.id} className="card" style={{ marginBottom: '0.75rem' }}>
            <div className="card-head section-head" style={{ marginBottom: '0.4rem' }}>
              <div>
                <h3>
                  {review.patient_first_name || 'Patient'} · visited {review.visited_on}
                </h3>
                <p className="muted small" style={{ margin: 0 }}>
                  submitted {new Date(review.created_at).toLocaleString()}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span className="rating-chip">
                  {'★'.repeat(review.rating)}
                  {'☆'.repeat(5 - review.rating)}
                </span>
                <StatusBadge status={review.status} />
              </div>
            </div>
            {review.comment && <blockquote className="review-quote">“{review.comment}”</blockquote>}
            {review.status === 'rejected' && review.moderation_note && (
              <p className="muted small" style={{ margin: 0 }}>
                Moderation note: {review.moderation_note}
              </p>
            )}
          </article>
        ))
      )}
    </>
  );
}
