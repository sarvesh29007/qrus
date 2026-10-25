import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth, homeForRole } from '../context/AuthContext.jsx';
import ChatBot from './ChatBot.jsx';

const NAV = {
  patient: [
    { to: '/patient', label: 'Overview', end: true },
    { to: '/patient/find', label: 'Find care' },
    { to: '/patient/appointments', label: 'Appointments' },
    { to: '/patient/waitlist', label: 'Waitlist' },
    { to: '/patient/reviews', label: 'Reviews' },
  ],
  doctor: [
    { to: '/doctor', label: 'Overview', end: true },
    { to: '/doctor/queue', label: 'Patient queue' },
    { to: '/doctor/schedule', label: 'Schedule' },
    { to: '/doctor/waitlist', label: 'Waitlist' },
    { to: '/doctor/reviews', label: 'Reviews' },
    { to: '/doctor/profile', label: 'Profile' },
  ],
  admin: [
    { to: '/admin', label: 'Overview', end: true },
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/reviews', label: 'Moderation' },
    { to: '/admin/audit', label: 'Audit log' },
  ],
};

const ROLE_LABEL = { patient: 'Patient portal', doctor: 'Doctor portal', admin: 'Admin console' };

/** Single chrome shared by all three portals; nav items differ per role. */
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const links = user ? NAV[user.role] || [] : [];

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to={user ? homeForRole(user.role) : '/login'} className="brand">
            <span className="brand-mark" aria-hidden="true">✚</span>
            <span className="brand-name">Qrus</span>
            {user && <span className="brand-portal">{ROLE_LABEL[user.role]}</span>}
          </NavLink>

          <nav className="main-nav" aria-label="Portal navigation">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="topbar-user">
            {user ? (
              <>
                <span className="user-chip">
                  <span className="user-avatar" aria-hidden="true">
                    {user.fullName?.charAt(0)?.toUpperCase() || '?'}
                  </span>
                  <span className="user-meta">
                    <strong>{user.fullName}</strong>
                    <small>{user.email}</small>
                  </span>
                </span>
                <button type="button" className="btn btn-ghost" onClick={handleLogout}>
                  Sign out
                </button>
              </>
            ) : (
              <NavLink className="btn btn-primary btn-sm" to="/login">
                Sign in
              </NavLink>
            )}
          </div>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <footer className="app-footer">
        <span>Qrus · secure healthcare scheduling</span>
        <span className="muted">All medical actions are recorded in the immutable audit log.</span>
      </footer>

      {/* Rendered last so it sits above the portal chrome on every page. */}
      <ChatBot />
    </div>
  );
}
