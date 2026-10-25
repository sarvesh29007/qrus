import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Alert from '../../components/Alert.jsx';

/**
 * Patient self-registration. Doctor and admin roles are intentionally NOT
 * selectable here: privileged accounts are provisioned by an administrator
 * (server enforces the same rule — 'admin' is absent from the register schema).
 */
export default function Register() {
  const { register } = useAuth();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await register({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone.trim() || undefined,
        role: 'patient',
      });
      window.location.assign('/patient');
    } catch (err) {
      const detail = Array.isArray(err.details) && err.details.length ? ` ${err.details[0].message}` : '';
      setError(`${err.message}${detail}`);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <section className="auth-panel">
        <Link to="/login" className="auth-brand">
          <span className="brand-mark" aria-hidden="true">✚</span> Qrus
        </Link>

        <h1>Create your patient account</h1>
        <p className="muted">Book appointments, join waitlists and review doctors after a completed visit.</p>

        {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

        <form className="auth-form" onSubmit={submit}>
          <div className="form-field">
            <label htmlFor="fullName">Full name</label>
            <input id="fullName" value={form.fullName} onChange={set('fullName')} placeholder="Priya Shah" required minLength={2} maxLength={120} />
          </div>
          <div className="form-field">
            <label htmlFor="regEmail">Email</label>
            <input id="regEmail" type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" required />
          </div>
          <div className="form-field">
            <label htmlFor="phone">Phone (optional)</label>
            <input id="phone" value={form.phone} onChange={set('phone')} placeholder="+91 90000 00000" maxLength={30} />
          </div>
          <div className="form-field">
            <label htmlFor="regPassword">Password</label>
            <input
              id="regPassword"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              required
              minLength={8}
            />
            <div className="form-hint">At least 8 characters — mix letters, numbers and a symbol.</div>
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="auth-alt">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
        <p className="auth-alt small muted">
          Medical staff accounts are provisioned by administrators to keep role assignment audited.
        </p>
      </section>

      <aside className="auth-hero">
        <div>
          <h2>Join Qrus in under a minute.</h2>
          <p>Your account is scoped to the patient portal; clinical and admin areas stay out of reach by design.</p>
        </div>
        <ul className="hero-points">
          <li>
            <span aria-hidden="true">⚡</span>
            <div>
              <strong>Instant specialty routing</strong>
              <span>Type your symptoms and see which department fits before you book.</span>
            </div>
          </li>
          <li>
            <span aria-hidden="true">🕐</span>
            <div>
              <strong>Waitlist that moves</strong>
              <span>Cancelled slots are handed to the highest-priority waiting patient automatically.</span>
            </div>
          </li>
        </ul>
      </aside>
    </div>
  );
}
