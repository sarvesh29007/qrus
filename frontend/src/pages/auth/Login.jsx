import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, homeForRole } from '../../context/AuthContext.jsx';
import Alert from '../../components/Alert.jsx';

const DEMOS = [
  { label: 'Patient', email: 'priya@qrus.dev', password: 'QrusPatient!1' },
  { label: 'Doctor', email: 'dr.meera@qrus.dev', password: 'QrusDoctor!1' },
  { label: 'Admin', email: 'admin@qrus.dev', password: 'QrusAdmin!1' },
];

export default function Login() {
  const { login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const next = new URLSearchParams(location.search).get('next');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await login(email.trim(), password);
      // Redirect client-side to ?next= or the portal that owns this role.
      navigate(next && next.startsWith('/') ? next : homeForRole(user.role), { replace: true });
    } catch (err) {
      const detail = Array.isArray(err.details) && err.details.length ? ` ${err.details[0].message}` : '';
      setError(`${err.message}${detail}`);
      setBusy(false);
    }
  }

  function fillDemo(demo) {
    setEmail(demo.email);
    setPassword(demo.password);
    setError('');
  }

  return (
    <div className="auth-screen">
      <section className="auth-panel">
        <Link to="/login" className="auth-brand">
          <span className="brand-mark" aria-hidden="true">✚</span> Qrus
        </Link>

        <h1>Sign in</h1>
        <p className="muted">Use the account issued for your role — patient, doctor or administrator.</p>

        {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

        <form className="auth-form" onSubmit={submit}>
          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="auth-alt">
          New patient? <Link to="/register">Create an account</Link>
        </p>
        <p className="auth-alt small muted">
          Doctors and clinic staff: Contact your administrator for login details.
        </p>
      </section>

      <aside className="auth-hero">
        <div>
          <h2>Book your doctor's appointment in minutes.</h2>
          <p>
            Find the right specialist, see live schedules, and join the waitlist to get seen faster.
          </p>
        </div>

        <ul className="hero-points">
          <li>
            <span aria-hidden="true">🩺</span>
            <div>
              <strong>Symptom-to-specialty matching</strong>
              <span>Tell us how you're feeling, and we'll connect you with the right doctor.</span>
            </div>
          </li>
          <li>
            <span aria-hidden="true">🗓️</span>
            <div>
              <strong>Real-time availability</strong>
              <span>See exactly which times are open right now and book instantly.</span>
            </div>
          </li>
          <li>
            <span aria-hidden="true">🔒</span>
            <div>
              <strong>Verified reviews</strong>
              <span>Read genuine feedback from patients after their completed visits.</span>
            </div>
          </li>
        </ul>

        <div className="demo-creds">
          <div>Demo credentials (development seed):</div>
          {DEMOS.map((demo) => (
            <div key={demo.email} style={{ marginTop: '0.35rem' }}>
              <code>{demo.email}</code> · <code>{demo.password}</code>{' '}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => fillDemo(demo)}>
                Use
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
