import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const TABS = [
  { id: 'pending', label: 'Queue' },
  { id: 'approved', label: 'Published' },
  { id: 'rejected', label: 'Rejected' },
  { id: '', label: 'All' },
];

/** Review moderation: approving recalculates the doctor's public rating. */
export default function AdminReviews() {
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState({}); // reviewId -> note text

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = status ? `?status=${status}` : '';
      setData(await get(`/admin/reviews${params}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(review, next) {
    const note = (notes[review.id] || '').trim();
    if (next === 'rejected' && !note) {
      setError(`Add a moderation note for review #${review.id} before rejecting it — the patient sees it.`);
      return;
    }
    setBusyId(review.id);
    setError('');
    setNotice('');
    try {
      await patch(`/admin/reviews/${review.id}`, { status: next, note });
      setNotice(`Review #${review.id} ${next}${next === 'approved' ? ' — the doctor’s public rating was recalculated' : ''}.`);
      setNotes((prev) => ({ ...prev, [review.id]: '' }));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const reviews = data?.reviews || [];
  const counts = Object.fromEntries((data?.counts || []).map((c) => [c.status, c.count]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review moderation</h1>
          <p>
            Reviews are gated upstream — only completed appointments can produce one — so moderation is the final
            publish step. Approving immediately feeds the doctor&apos;s public rating.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-ghost" to="/admin/audit">
            View moderation audit
          </Link>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Moderation filter">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={status === tab.id}
            className={`tab${status === tab.id ? ' is-active' : ''}`}
            onClick={() => setStatus(tab.id)}
          >
            {tab.label}
            {tab.id && counts[tab.id] !== undefined ? ` (${counts[tab.id]})` : ''}
          </button>
        ))}
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {loading ? (
        <Spinner label="Loading moderation queue…" full />
      ) : reviews.length === 0 ? (
        <p className="empty-note">
          {status === 'pending' ? 'Queue is clear — nothing waiting for moderation.' : 'No reviews in this view.'}
        </p>
      ) : (
        reviews.map((review) => (
          <article key={review.id} className="moderation-card">
            <div className="moderation-head">
              <div>
                <h3>
                  {review.patient_name} → {review.doctor_name}
                </h3>
                <p className="muted small" style={{ margin: 0 }}>
                  {review.specialty_name} · visit {review.visited_on} · submitted{' '}
                  {new Date(review.created_at).toLocaleString()}
                  {review.moderated_at ? ` · moderated ${new Date(review.moderated_at).toLocaleString()}` : ''}
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
            {review.moderation_note && (
              <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
                Previous note: {review.moderation_note}
              </p>
            )}

            <div className="moderation-actions">
              <input
                value={notes[review.id] || ''}
                onChange={(e) => setNotes((prev) => ({ ...prev, [review.id]: e.target.value }))}
                placeholder="Moderation note (required to reject)"
                maxLength={500}
                aria-label={`Moderation note for review ${review.id}`}
                disabled={busyId === review.id}
              />
              {review.status !== 'approved' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busyId === review.id}
                  onClick={() => decide(review, 'approved')}
                >
                  {busyId === review.id ? 'Working…' : 'Approve'}
                </button>
              )}
              {review.status !== 'rejected' && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busyId === review.id}
                  onClick={() => decide(review, 'rejected')}
                >
                  Reject
                </button>
              )}
            </div>
          </article>
        ))
      )}
    </>
  );
}
