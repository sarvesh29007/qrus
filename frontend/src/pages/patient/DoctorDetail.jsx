import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import SlotGrid from '../../components/SlotGrid.jsx';
import { Stars } from '../../components/DoctorCard.jsx';

/** Doctor profile + live availability + booking, the patient booking surface. */
export default function DoctorDetail() {
  const { doctorId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const [picked, setPicked] = useState(null); // slot chosen for booking
  const [form, setForm] = useState({ reason: '', symptoms: '' });
  const [booking, setBooking] = useState(false);
  const [notice, setNotice] = useState(null); // { kind, text }
  const [gridVersion, setGridVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await get(`/doctors/${doctorId}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [doctorId]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmBooking() {
    if (!picked) return;
    setBooking(true);
    setNotice(null);
    try {
      await post('/appointments', {
        slotId: picked.id,
        reason: form.reason.trim(),
        symptoms: form.symptoms.trim(),
      });
      setNotice({
        kind: 'success',
        text: `Booked with ${data.doctor.name} on ${picked.date} at ${picked.start}. The doctor will confirm shortly.`,
      });
      setPicked(null);
      setForm({ reason: '', symptoms: '' });
      setGridVersion((v) => v + 1); // remount grid → fresh availability
      load();
    } catch (err) {
      setNotice({
        kind: 'error',
        text: `${err.message} Someone may have taken this slot a moment ago — pick another.`,
      });
      setGridVersion((v) => v + 1);
    } finally {
      setBooking(false);
    }
  }

  if (loading) return <Spinner label="Loading doctor…" full />;
  if (error && !data) {
    return (
      <div className="state-panel">
        <div className="state-icon" aria-hidden="true">⚠️</div>
        <h1>Could not load this doctor</h1>
        <p>{error}</p>
        <Link className="btn btn-primary" to="/patient/find">Back to search</Link>
      </div>
    );
  }

  const { doctor, reviews = [], availability = [], canBook } = data;
  const hasOpen = availability.some((d) => d.open > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted small">
            <Link to="/patient/find">← Back to search</Link>
          </p>
          <h1>{doctor.name}</h1>
          <p>
            {doctor.specialty_name} · {doctor.clinic_name || 'Clinic not listed'}
            {doctor.city ? ` · ${doctor.city}` : ''}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-ghost" to={`/patient/waitlist?doctorId=${doctor.id}`}>
            Join waitlist
          </Link>
        </div>
      </div>

      {notice && (
        <Alert kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <div className="detail-grid section">
        <div>
          <section className="card section">
            <div className="card-head section-head">
              <h2>Availability</h2>
              <span className="muted small">live · updates as slots are taken</span>
            </div>

            {!canBook ? (
              <p className="empty-note">This doctor is not accepting new patients right now — join the waitlist instead.</p>
            ) : !hasOpen ? (
              <>
                <p className="empty-note">No open slots in the next two weeks. Join the waitlist to be booked automatically.</p>
                <Link className="btn btn-secondary" to={`/patient/waitlist?doctorId=${doctor.id}`}>
                  Join this doctor&apos;s waitlist
                </Link>
              </>
            ) : (
              <SlotGrid
                key={gridVersion}
                doctorId={doctor.id}
                onSelect={(slot) => {
                  setPicked(slot);
                  setNotice(null);
                }}
              />
            )}
          </section>

          {picked && (
            <section className="card section">
              <div className="card-head">
                <h2>
                  Book {picked.date} at {picked.start}
                </h2>
                <p className="muted">Share enough context for the doctor to prepare for your visit.</p>
              </div>

              <div className="form-field">
                <label htmlFor="reason">Reason for the visit</label>
                <input
                  id="reason"
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  placeholder="e.g. Chest tightness follow-up"
                  maxLength={500}
                />
              </div>
              <div className="form-field">
                <label htmlFor="symptoms">Symptoms (visible to your doctor)</label>
                <textarea
                  id="symptoms"
                  value={form.symptoms}
                  onChange={(e) => setForm({ ...form, symptoms: e.target.value })}
                  placeholder="e.g. chest tightness when climbing stairs, mild breathlessness"
                  maxLength={2000}
                />
                <div className="form-hint">Stored encrypted at rest and written to the audit log when a doctor opens them.</div>
              </div>

              <div className="page-actions">
                <button className="btn btn-primary" onClick={confirmBooking} disabled={booking}>
                  {booking ? 'Booking…' : `Confirm ${picked.start} slot`}
                </button>
                <button className="btn btn-ghost" onClick={() => setPicked(null)} disabled={booking}>
                  Cancel
                </button>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head section-head">
              <h2>Patient reviews</h2>
              <Stars value={doctor.rating_avg || 0} count={doctor.rating_count || 0} />
            </div>
            {reviews.length === 0 ? (
              <p className="empty-note">No published reviews yet — reviews appear only after a completed visit.</p>
            ) : (
              reviews.map((r) => (
                <blockquote key={r.id} className="review-quote">
                  “{r.comment || 'No written feedback.'}”
                  <span className="muted">
                    {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} · {r.patient_first_name} · visited{' '}
                    {r.visited_on}
                  </span>
                </blockquote>
              ))
            )}
          </section>
        </div>

        <aside className="card">
          <div className="card-head">
            <h2>Profile</h2>
          </div>
          <dl className="kv">
            <dt>Specialty</dt>
            <dd>{doctor.specialty_name}</dd>
            <dt>Experience</dt>
            <dd>{doctor.years_experience} years</dd>
            <dt>Fee</dt>
            <dd>₹{doctor.consultation_fee}</dd>
            <dt>License</dt>
            <dd className="mono">{doctor.license_number}</dd>
            <dt>Languages</dt>
            <dd>{(doctor.languages || []).join(', ') || '—'}</dd>
            <dt>Accepting</dt>
            <dd>{doctor.accepting_new_patients ? 'Yes' : 'No'}</dd>
          </dl>
          {doctor.bio && <p className="muted small" style={{ marginTop: '0.9rem' }}>{doctor.bio}</p>}
        </aside>
      </div>
    </>
  );
}
