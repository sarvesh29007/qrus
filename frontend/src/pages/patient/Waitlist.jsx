import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, get, post } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const URGENCY = [
  { id: 'routine', label: 'Routine — flexible' },
  { id: 'soon', label: 'Soon — this week' },
  { id: 'urgent', label: 'Urgent — as fast as possible' },
];

export default function MyWaitlist() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [entries, setEntries] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [specialties, setSpecialties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);

  const [form, setForm] = useState({
    target: 'doctor',
    doctorId: '',
    specialtyId: '',
    symptoms: '',
    urgency: 'soon',
    from: '',
    to: '',
  });
  const [joining, setJoining] = useState(false);

  // Deep link from a doctor page: /patient/waitlist?doctorId=42
  useEffect(() => {
    const doctorId = searchParams.get('doctorId');
    if (doctorId) setForm((prev) => ({ ...prev, target: 'doctor', doctorId }));
  }, [searchParams]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [wl, docs, specs] = await Promise.all([
        get('/waitlist'),
        get('/doctors?limit=50&sort=rating'),
        get('/specialties'),
      ]);
      setEntries(wl.entries || []);
      setDoctors(docs.doctors || []);
      setSpecialties(specs.specialties || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function join(event) {
    event.preventDefault();
    setJoining(true);
    setError('');
    setNotice(null);
    try {
      const payload = {
        symptoms: form.symptoms.trim(),
        urgency: form.urgency,
        ...(form.from ? { preferredDateFrom: form.from } : {}),
        ...(form.to ? { preferredDateTo: form.to } : {}),
        ...(form.target === 'doctor' && form.doctorId ? { doctorId: Number(form.doctorId) } : {}),
        ...(form.target === 'specialty' && form.specialtyId ? { specialtyId: Number(form.specialtyId) } : {}),
      };
      const res = await post('/waitlist', payload);
      if (res.matchedImmediately) {
        setNotice({
          kind: 'success',
          text: `A slot was already free — booked for you on ${res.appointment.scheduled_date} at ${res.appointment.scheduled_time}.`,
        });
      } else {
        setNotice({ kind: 'success', text: 'You are on the waitlist. We will book you the moment a slot opens.' });
      }
      setForm((prev) => ({ ...prev, symptoms: '' }));
      setSearchParams({}, { replace: true });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setJoining(false);
    }
  }

  async function leave(entry) {
    setError('');
    try {
      await del(`/waitlist/${entry.id}`);
      setNotice({ kind: 'success', text: 'You left that waitlist — your position was released to the next patient.' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <Spinner label="Loading waitlists…" full />;

  const waiting = entries.filter((e) => e.status === 'waiting');
  const settled = entries.filter((e) => e.status !== 'waiting');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Waitlist</h1>
          <p>
            The queue is ranked by urgency, then by who joined first. Cancelled appointments are offered to the top
            of the queue automatically.
          </p>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <div className="detail-grid section">
        <section className="card">
          <div className="card-head">
            <h2>Your queue positions</h2>
            <p className="muted">{waiting.length ? `${waiting.length} active request(s).` : 'No active requests.'}</p>
          </div>

          {entries.length === 0 ? (
            <p className="empty-note">You have not joined any waitlist yet — use the form to request one.</p>
          ) : (
            <>
              {waiting.map((e) => (
                <article key={e.id} className="wait-card">
                  <div className="wait-card-head">
                    <h3>{e.doctor_name || e.specialty_name}</h3>
                    <span className="wait-position">
                      #{e.position} <small>of {e.queue_length}</small>
                    </span>
                  </div>
                  <p className="muted small" style={{ margin: '0.35rem 0 0' }}>
                    {e.symptoms}
                  </p>
                  <div className="wait-meta">
                    <span className={`urgency urgency-${e.urgency}`}>{e.urgency}</span>
                    <span>{e.specialty_name}</span>
                    <span>joined {new Date(e.joined_at).toLocaleString()}</span>
                    {e.preferred_date_from && (
                      <span>
                        window {e.preferred_date_from} → {e.preferred_date_to}
                      </span>
                    )}
                    <span>expires {e.expires_at?.slice(0, 10)}</span>
                  </div>
                  <div className="appt-actions">
                    <StatusBadge status={e.status} />
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => leave(e)}>
                      Leave queue
                    </button>
                  </div>
                </article>
              ))}

              {settled.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <h3 className="muted" style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    History
                  </h3>
                  <ul className="timeline">
                    {settled.map((e) => (
                      <li key={e.id}>
                        <span className="tl-action">{e.doctor_name || e.specialty_name}</span>
                        <span className="tl-meta">{new Date(e.joined_at).toLocaleDateString()}</span>
                        <StatusBadge status={e.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>

        <aside className="card">
          <div className="card-head">
            <h2>Request a slot</h2>
            <p className="muted">If something frees up in your window, it is yours automatically.</p>
          </div>

          <form onSubmit={join}>
            <div className="form-field">
              <label htmlFor="target">Waitlist for</label>
              <select
                id="target"
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
              >
                <option value="doctor">A specific doctor</option>
                <option value="specialty">Any doctor in a specialty</option>
              </select>
            </div>

            {form.target === 'doctor' ? (
              <div className="form-field">
                <label htmlFor="doctor">Doctor</label>
                <select
                  id="doctor"
                  value={form.doctorId}
                  onChange={(e) => setForm({ ...form, doctorId: e.target.value })}
                  required
                >
                  <option value="">Choose a doctor…</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} · {d.specialty_name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="form-field">
                <label htmlFor="specialty">Specialty</label>
                <select
                  id="specialty"
                  value={form.specialtyId}
                  onChange={(e) => setForm({ ...form, specialtyId: e.target.value })}
                  required
                >
                  <option value="">Choose a specialty…</option>
                  {specialties.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="form-field">
              <label htmlFor="wlSymptoms">Symptoms</label>
              <textarea
                id="wlSymptoms"
                value={form.symptoms}
                onChange={(e) => setForm({ ...form, symptoms: e.target.value })}
                placeholder="e.g. severe lower back pain, difficulty standing straight"
                required
                minLength={2}
                maxLength={2000}
              />
            </div>

            <div className="form-field">
              <label htmlFor="urgency">Urgency</label>
              <select id="urgency" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
                {URGENCY.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="from">Preferred from</label>
                <input id="from" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
              </div>
              <div className="form-field">
                <label htmlFor="to">Preferred to</label>
                <input id="to" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
              </div>
            </div>
            {form.from && form.to && form.to < form.from && (
              <p className="form-error">The end date must be on or after the start date.</p>
            )}

            <button className="btn btn-primary btn-block" type="submit" disabled={joining}>
              {joining ? 'Joining…' : 'Join the waitlist'}
            </button>
          </form>
        </aside>
      </div>
    </>
  );
}
