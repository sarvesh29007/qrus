import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, homeForRole } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Spinner from './components/Spinner.jsx';

import Login from './pages/auth/Login.jsx';
import Register from './pages/auth/Register.jsx';
import NotFound from './pages/NotFound.jsx';

import PatientDashboard from './pages/patient/Dashboard.jsx';
import FindCare from './pages/patient/FindCare.jsx';
import DoctorDetail from './pages/patient/DoctorDetail.jsx';
import MyAppointments from './pages/patient/Appointments.jsx';
import MyWaitlist from './pages/patient/Waitlist.jsx';
import MyReviews from './pages/patient/Reviews.jsx';

import DoctorDashboard from './pages/doctor/Dashboard.jsx';
import DoctorQueue from './pages/doctor/Queue.jsx';
import DoctorSchedule from './pages/doctor/Schedule.jsx';
import DoctorWaitlist from './pages/doctor/Waitlist.jsx';
import DoctorReviews from './pages/doctor/Reviews.jsx';
import DoctorProfile from './pages/doctor/Profile.jsx';

import AdminDashboard from './pages/admin/Dashboard.jsx';
import AdminUsers from './pages/admin/Users.jsx';
import AdminAudit from './pages/admin/Audit.jsx';
import AdminReviews from './pages/admin/Reviews.jsx';

/** Signed-in users never see /login or /register again. */
function GuestOnly({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();
  if (booting) return <Spinner label="Restoring your session…" full />;
  if (user) {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate to={next && next.startsWith('/') ? next : homeForRole(user.role)} replace />;
  }
  return children;
}

function HomeRedirect() {
  const { user, booting } = useAuth();
  if (booting) return <Spinner label="Restoring your session…" full />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={homeForRole(user.role)} replace />;
}

/**
 * The three portals are isolated by route prefix + role guard: /patient only
 * admits role 'patient', /doctor only 'doctor', /admin only 'admin'. Anything
 * else (an admin probing /patient, say) renders the shared Forbidden panel
 * rather than leaking the portal shell.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />

      <Route
        path="/login"
        element={
          <GuestOnly>
            <Login />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <Register />
          </GuestOnly>
        }
      />

      <Route element={<Layout />}>
        {/* --- Patient portal --------------------------------------------- */}
        <Route
          path="/patient"
          element={
            <ProtectedRoute role="patient">
              <PatientDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patient/find"
          element={
            <ProtectedRoute role="patient">
              <FindCare />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patient/doctors/:doctorId"
          element={
            <ProtectedRoute role="patient">
              <DoctorDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patient/appointments"
          element={
            <ProtectedRoute role="patient">
              <MyAppointments />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patient/waitlist"
          element={
            <ProtectedRoute role="patient">
              <MyWaitlist />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patient/reviews"
          element={
            <ProtectedRoute role="patient">
              <MyReviews />
            </ProtectedRoute>
          }
        />

        {/* --- Doctor portal ---------------------------------------------- */}
        <Route
          path="/doctor"
          element={
            <ProtectedRoute role="doctor">
              <DoctorDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/doctor/queue"
          element={
            <ProtectedRoute role="doctor">
              <DoctorQueue />
            </ProtectedRoute>
          }
        />
        <Route
          path="/doctor/schedule"
          element={
            <ProtectedRoute role="doctor">
              <DoctorSchedule />
            </ProtectedRoute>
          }
        />
        <Route
          path="/doctor/waitlist"
          element={
            <ProtectedRoute role="doctor">
              <DoctorWaitlist />
            </ProtectedRoute>
          }
        />
        <Route
          path="/doctor/reviews"
          element={
            <ProtectedRoute role="doctor">
              <DoctorReviews />
            </ProtectedRoute>
          }
        />
        <Route
          path="/doctor/profile"
          element={
            <ProtectedRoute role="doctor">
              <DoctorProfile />
            </ProtectedRoute>
          }
        />

        {/* --- Admin portal ------------------------------------------------ */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute role="admin">
              <AdminDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/users"
          element={
            <ProtectedRoute role="admin">
              <AdminUsers />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <ProtectedRoute role="admin">
              <AdminAudit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/reviews"
          element={
            <ProtectedRoute role="admin">
              <AdminReviews />
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
