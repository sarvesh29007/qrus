import { useCallback, useEffect, useState } from 'react';
import { get, patch, post } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const ROLES = ['patient', 'doctor', 'admin'];
const STATUSES = ['active', 'pending', 'suspended'];

export default function AdminUsers() {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [creating, setCreating] = useState(false);
  const [specialties, setSpecialties] = useState([]);
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    phone: '',
    role: 'patient',
    specialtyId: '',
    licenseNumber: '',
    yearsExperience: '',
    consultationFee: '',
    clinicName: '',
    city: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (q.trim()) params.set('q', q.trim());
      if (role) params.set('role', role);
      if (status) params.set('status', status);
      setData(await get(`/admin/users?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [q, role, status, page]);

  useEffect(() => {
    const timer = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  useEffect(() => {
    get('/specialties')
      .then((d) => setSpecialties(d.specialties || []))
      .catch(() => {});
  }, []);

  async function changeRole(user, nextRole) {
    if (nextRole === user.role) return;
    setBusyId(user.id);
    setError('');
    setNotice('');
    try {
      await patch(`/admin/users/${user.id}/role`, { role: nextRole });
      setNotice(`${user.fullName} is now a ${nextRole}. The change takes effect on their next request.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function changeStatus(user, nextStatus) {
    setBusyId(user.id);
    setError('');
    setNotice('');
    const reason =
      nextStatus === 'suspended'
        ? window.prompt(`Reason for suspending ${user.fullName} (recorded in the audit log):`, '') || ''
        : '';
    if (nextStatus === 'suspended' && reason === '' && !window.confirm('Suspend without a reason? Continue?')) {
      setBusyId(null);
      return;
    }
    try {
      await patch(`/admin/users/${user.id}/status`, { status: nextStatus, reason: reason.trim() });
      setNotice(`${user.fullName} set to ${nextStatus}.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      const payload = {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
      };
      if (form.phone.trim()) payload.phone = form.phone.trim();
      if (form.role === 'doctor') {
        if (form.specialtyId) payload.specialtyId = Number(form.specialtyId);
        if (form.licenseNumber.trim()) payload.licenseNumber = form.licenseNumber.trim();
        if (form.yearsExperience !== '') payload.yearsExperience = Number(form.yearsExperience);
        if (form.consultationFee !== '') payload.consultationFee = Number(form.consultationFee);
        if (form.clinicName.trim()) payload.clinicName = form.clinicName.trim();
        if (form.city.trim()) payload.city = form.city.trim();
      }
      await post('/admin/users', payload);
      setNotice(`Account created for ${payload.email}.`);
      setCreating(false);
      setForm({ ...form, fullName: '', email: '', password: '', phone: '' });
      load();
    } catch (err) {
      const detail = Array.isArray(err.details) && err.details.length ? ` ${err.details[0].message}` : '';
      setError(`${err.message}${detail}`);
    }
  }

  const users = data?.users || [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>
            Provision accounts, escalate roles and suspend access. Role and status are re-checked on every request,
            so a change applies immediately — tokens cannot outlive it.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Close' : '+ Create account'}
          </button>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {creating && (
        <form className="card section" onSubmit={createUser}>
          <div className="card-head">
            <h2>Provision an account</h2>
            <p className="muted">Doctors get a profile; admins can manage the whole platform.</p>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label htmlFor="nuName">Full name</label>
              <input id="nuName" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required minLength={2} maxLength={120} />
            </div>
            <div className="form-field">
              <label htmlFor="nuEmail">Email</label>
              <input id="nuEmail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="form-field">
              <label htmlFor="nuPassword">Temporary password</label>
              <input id="nuPassword" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
            </div>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label htmlFor="nuRole">Role</label>
              <select id="nuRole" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="nuPhone">Phone (optional)</label>
              <input id="nuPhone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} />
            </div>
            {form.role === 'doctor' && (
              <div className="form-field">
                <label htmlFor="nuSpec">Specialty</label>
                <select id="nuSpec" value={form.specialtyId} onChange={(e) => setForm({ ...form, specialtyId: e.target.value })} required>
                  <option value="">Choose…</option>
                  {specialties.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {form.role === 'doctor' && (
            <div className="form-row">
              <div className="form-field">
                <label htmlFor="nuLicense">License number</label>
                <input id="nuLicense" value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} required minLength={3} maxLength={60} />
              </div>
              <div className="form-field">
                <label htmlFor="nuExp">Years of experience</label>
                <input id="nuExp" type="number" min="0" max="60" value={form.yearsExperience} onChange={(e) => setForm({ ...form, yearsExperience: e.target.value })} />
              </div>
              <div className="form-field">
                <label htmlFor="nuFee">Consultation fee (₹)</label>
                <input id="nuFee" type="number" min="0" max="100000" value={form.consultationFee} onChange={(e) => setForm({ ...form, consultationFee: e.target.value })} />
              </div>
              <div className="form-field">
                <label htmlFor="nuCity">City</label>
                <input id="nuCity" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} maxLength={80} />
              </div>
            </div>
          )}

          <button className="btn btn-primary" type="submit">
            Create account
          </button>
        </form>
      )}

      <div className="filter-bar">
        <div className="filter-field">
          <label htmlFor="uq">Search</label>
          <input id="uq" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Name or email" />
        </div>
        <div className="filter-field">
          <label htmlFor="urole">Role</label>
          <select id="urole" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="ustatus">Status</label>
          <select id="ustatus" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <Spinner label="Loading users…" full />
      ) : users.length === 0 ? (
        <p className="empty-note">No accounts match those filters.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.full_name}</strong>
                    {user.phone && <div className="muted small">{user.phone}</div>}
                  </td>
                  <td>{user.email}</td>
                  <td>
                    <select
                      className="role-select"
                      value={user.role}
                      disabled={busyId === user.id}
                      onChange={(e) => changeRole(user, e.target.value)}
                      aria-label={`Role for ${user.full_name}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <StatusBadge status={user.status} />
                  </td>
                  <td className="muted">{new Date(user.created_at).toLocaleDateString()}</td>
                  <td className="actions">
                    {user.status === 'suspended' ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={busyId === user.id}
                        onClick={() => changeStatus(user, 'active')}
                      >
                        Reactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={busyId === user.id}
                        onClick={() => changeStatus(user, 'suspended')}
                      >
                        Suspend
                      </button>
                    )}
                    {user.status === 'pending' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busyId === user.id}
                        onClick={() => changeStatus(user, 'active')}
                      >
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <span>
              Page {data?.page || 1} · {users.length} shown
            </span>
            <span style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← Previous
              </button>
              <button className="btn btn-ghost btn-sm" disabled={users.length < 25} onClick={() => setPage((p) => p + 1)}>
                Next →
              </button>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
