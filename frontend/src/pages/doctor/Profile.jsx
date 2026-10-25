import { useEffect, useState } from 'react';
import { get, patch } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';

const asBool = (value) => value === true || value === 'true';

/** Doctor profile editor: how patients see and reach this practice. */
export default function DoctorProfile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState(null);

  useEffect(() => {
    get('/auth/me')
      .then((data) => {
        const p = data.profile || {};
        setProfile(p);
        setForm({
          bio: p.bio || '',
          consultationFee: p.consultation_fee ?? 0,
          clinicName: p.clinic_name || '',
          city: p.city || '',
          languages: (p.languages || []).join(', '),
          acceptingNewPatients: asBool(p.accepting_new_patients),
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await patch('/doctor/profile', {
        bio: form.bio.trim(),
        consultationFee: Number(form.consultationFee),
        clinicName: form.clinicName.trim() || null,
        city: form.city.trim() || null,
        languages: form.languages
          .split(',')
          .map((lang) => lang.trim())
          .filter(Boolean)
          .slice(0, 10),
        acceptingNewPatients: form.acceptingNewPatients,
      });
      setNotice('Profile saved — patients see the update immediately.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label="Loading profile…" full />;
  if (!form) return <Alert kind="error">No doctor profile found for this account.</Alert>;

  const set = (key) => (event) =>
    setForm({
      ...form,
      [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value,
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>This is what patients see when they search for care.</p>
        </div>
        {profile && (
          <div className="page-actions">
            <span className="rating-chip">
              {'★'.repeat(Math.round(profile.rating_avg || 0))}
              {'☆'.repeat(5 - Math.round(profile.rating_avg || 0))} {Number(profile.rating_avg || 0).toFixed(1)} (
              {profile.rating_count || 0})
            </span>
          </div>
        )}
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      <form className="card" onSubmit={save} style={{ maxWidth: '720px' }}>
        <div className="card-head">
          <h2>Practice details</h2>
        </div>

        <div className="form-row">
          <div className="form-field">
            <label htmlFor="clinic">Clinic name</label>
            <input id="clinic" value={form.clinicName} onChange={set('clinicName')} maxLength={120} placeholder="My Family Clinic" />
          </div>
          <div className="form-field">
            <label htmlFor="city">City</label>
            <input id="city" value={form.city} onChange={set('city')} maxLength={80} placeholder="Pune" />
          </div>
        </div>

        <div className="form-row">
          <div className="form-field">
            <label htmlFor="fee">Consultation fee (₹)</label>
            <input id="fee" type="number" min="0" max="100000" value={form.consultationFee} onChange={set('consultationFee')} />
          </div>
          <div className="form-field">
            <label htmlFor="langs">Languages spoken</label>
            <input id="langs" value={form.languages} onChange={set('languages')} placeholder="English, Hindi" />
            <div className="form-hint">Comma separated, up to 10.</div>
          </div>
        </div>

        <div className="form-field">
          <label htmlFor="bio">Short bio</label>
          <textarea id="bio" rows={4} maxLength={1000} value={form.bio} onChange={set('bio')} />
          <div className="form-hint">Shown on your public profile page.</div>
        </div>

        <div className="form-field">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={form.acceptingNewPatients}
              onChange={set('acceptingNewPatients')}
              style={{ width: 'auto' }}
            />
            Accepting new patients
          </label>
          <div className="form-hint">When off, patients can only join your waitlist.</div>
        </div>

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </>
  );
}
