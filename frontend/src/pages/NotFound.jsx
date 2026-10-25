import { Link } from 'react-router-dom';
import { useAuth, homeForRole } from '../context/AuthContext.jsx';

export default function NotFound() {
  const { user } = useAuth();
  return (
    <div className="state-panel">
      <div className="state-icon" aria-hidden="true">🧭</div>
      <h1>Page not found</h1>
      <p>The address you opened does not exist in this portal.</p>
      <Link className="btn btn-primary" to={user ? homeForRole(user.role) : '/login'}>
        {user ? 'Back to my portal' : 'Back to sign in'}
      </Link>
    </div>
  );
}
