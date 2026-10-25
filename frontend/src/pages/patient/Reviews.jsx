import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

/**
 * Verified reviews: the server only lists appointments that are completed and
 * unreviewed, and re-checks the same gate on POST — this form simply reflects
 * that contract, so a review can never be attached to an upcoming visit.
 */
function ReviewForm({ appointment, onDone }) {
  const [rating, setRating] = useState(5);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/reviews', { appointmentId: appointment.id, rating, comment: comment.trim() });
      onDone(appointment);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="review-form" onSubmit={submit}>
      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

      <div className="form-field">
        <label id={`rating-label-${appointment.id}`}>Your rating</label>
        <div className="star-picker" role="radiogroup" aria-labelledby={`rating-label-${appointment.id}`}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
              className={`star${(hover || rating) >= value ? ' is-on' : ''}`}
              onMouseEnter={() => setHover(value)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(value)}
            >
              ★
            </button>
          ))}
          <span className="muted small">{rating} / 5</span>
        </div>
      </div>

      <div className="form-field">
        <label htmlFor={`comment-${appointment.id}`}>What would you tell other patients?</label>
        <textarea
          id={`comment-${appointment.id}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={1200}
          placeholder="Optional, but a sentence or two helps others choose well."
        />
        <div className="form-hint">
          Published only after an administrator approves it. Your first name is shown, never your full record.
        </div>
      </div>

      <div className="page-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit verified review'}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => onDone(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function MyReviews() {
  const [eligible, setEligible] = useState([]);
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [openForm, setOpenForm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [el, mn] = await Promise.all([get('/reviews/eligible'), get('/reviews/mine')]);
      setEligible(el.appointments || []);
      setMine(mn.reviews || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleDone(appointment) {
    if (appointment) {
      setNotice({
        kind: 'success',
        text: 'Review submitted — it enters the moderation queue and appears publicly once approved.',
      });
      setOpenForm(null);
      load();
    } else {
      setOpenForm(null);
    }
  }

  if (loading) return <Spinner label="Loading reviews…" full />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reviews</h1>
          <p>
            Qrus verifies every review: only a <strong>completed</strong> appointment unlocks the form, and each
            appointment can be reviewed exactly once.
          </p>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Ready to review</h2>
          <span className="muted small">{eligible.length} completed visit(s) without a review</span>
        </div>

        {eligible.length === 0 ? (
          <p className="empty-note">
            Nothing to review right now. Reviews unlock after a visit is marked completed — see your{' '}
            <Link to="/patient/appointments?view=past">past appointments</Link>.
          </p>
        ) : (
          eligible.map((appointment) => (
            <article key={appointment.id} className="card" style={{ marginBottom: '0.75rem' }}>
              <div className="card-head section-head">
                <div>
                  <h3>{appointment.doctor_name}</h3>
                  <p className="muted small" style={{ margin: 0 }}>
                    {appointment.specialty_name} · visited {appointment.scheduled_date}
                  </p>
                </div>
                {openForm === appointment.id ? null : (
                  <button className="btn btn-primary btn-sm" onClick={() => setOpenForm(appointment.id)}>
                    Write review
                  </button>
                )}
              </div>
              {openForm === appointment.id && <ReviewForm appointment={appointment} onDone={handleDone} />}
            </article>
          ))
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Your reviews</h2>
        </div>

        {mine.length === 0 ? (
          <p className="empty-note">You have not published or submitted any reviews yet.</p>
        ) : (
          mine.map((review) => (
            <article key={review.id} className="card" style={{ marginBottom: '0.75rem' }}>
              <div className="card-head section-head" style={{ marginBottom: '0.4rem' }}>
                <div>
                  <h3>{review.doctor_name}</h3>
                  <p className="muted small" style={{ margin: 0 }}>
                    {review.specialty_name} · visit {review.scheduled_date}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span className="rating-chip">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span>
                  <StatusBadge status={review.status} />
                </div>
              </div>
              {review.comment && <blockquote className="review-quote">“{review.comment}”</blockquote>}
              {review.status === 'pending' && (
                <p className="muted small" style={{ margin: 0 }}>
                  Awaiting admin moderation — usually cleared within a day.
                </p>
              )}
              {review.status === 'rejected' && review.moderation_note && (
                <p className="muted small" style={{ margin: 0 }}>
                  Moderation note: {review.moderation_note}
                </p>
              )}
            </article>
          ))
        )}
      </section>
    </>
  );
}
