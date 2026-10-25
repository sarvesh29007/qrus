import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth, homeForRole } from '../context/AuthContext.jsx';
import Spinner from './Spinner.jsx';

/**
 * Guards a portal subtree. Three outcomes:
 *   - session still booting   -> spinner
 *   - not signed in           -> /login?next=<current path>
 *   - wrong role              -> shared Forbidden panel (no portal chrome leaks)
 * A single role string is used because each portal admits exactly one role.
 */
export default function ProtectedRoute({ role, children }) {
  const { user, booting } = useAuth();
  const location = useLocation();

  if (booting) return <Spinner label="Checking your session…" full />;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (role && user.role !== role) {
    return (
      <div className="state-panel">
        <div className="state-icon" aria-hidden="true">🔒</div>
        <h1>Access restricted</h1>
        <p>
          Your account is signed in as <strong>{user.role}</strong>, and this area is reserved for the{' '}
          <strong>{role}</strong> portal.
        </p>
        <Link className="btn btn-primary" to={homeForRole(user.role)}>
          Go to my portal
        </Link>
      </div>
    );
  }
  return children;
}
