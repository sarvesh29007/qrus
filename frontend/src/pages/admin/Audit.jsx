import { useCallback, useEffect, useState } from 'react';
import { get } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';

const OUTCOMES = [
  { id: '', label: 'Any outcome' },
  { id: 'success', label: 'Success' },
  { id: 'failure', label: 'Failure' },
];

/**
 * Read-only audit browser. The table itself forbids UPDATE/DELETE, so this UI
 * only ever filters and pages through it. Each row can expand its captured
 * metadata and request id for incident investigation.
 */
export default function AdminAudit() {
  const [filters, setFilters] = useState({ action: '', entityType: '', outcome: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openRow, setOpenRow] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (filters.action) params.set('action', filters.action);
      if (filters.entityType) params.set('entityType', filters.entityType);
      if (filters.outcome) params.set('outcome', filters.outcome);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      setData(await get(`/admin/audit-logs?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters, page, limit]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (key) => (event) => {
    setFilters((prev) => ({ ...prev, [key]: event.target.value }));
    setPage(1);
    setOpenRow(null);
  };

  const rows = data?.logs || [];
  const knownActions = data?.knownActions || [];
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / limit));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>
            Every authentication, record access and medical state change — append-only, with actor, outcome and
            request correlation captured at write time.
          </p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-field">
          <label htmlFor="aAction">Action</label>
          <select id="aAction" value={filters.action} onChange={update('action')}>
            <option value="">All actions</option>
            {knownActions.map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} ({a.count})
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="aEntity">Entity type</label>
          <input id="aEntity" value={filters.entityType} onChange={update('entityType')} placeholder="e.g. appointment" />
        </div>
        <div className="filter-field">
          <label htmlFor="aOutcome">Outcome</label>
          <select id="aOutcome" value={filters.outcome} onChange={update('outcome')}>
            {OUTCOMES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="aFrom">From</label>
          <input id="aFrom" type="date" value={filters.from} onChange={update('from')} />
        </div>
        <div className="filter-field">
          <label htmlFor="aTo">To</label>
          <input id="aTo" type="date" value={filters.to} onChange={update('to')} />
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Spinner label="Reading audit trail…" full />
      ) : rows.length === 0 ? (
        <p className="empty-note">No audit entries match these filters.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Entity</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{new Date(row.created_at).toLocaleString()}</td>
                  <td>
                    <span className="al-action" style={{ fontFamily: 'var(--mono)', fontSize: '0.76rem', background: 'var(--slate-100)', padding: '0.05rem 0.4rem', borderRadius: '4px' }}>
                      {row.action}
                    </span>
                  </td>
                  <td>
                    {row.actor_name || (row.actor_role === 'system' ? 'system' : `#${row.actor_id}`)}
                    <div className="muted small">
                      {row.actor_role}
                      {row.actor_email ? ` · ${row.actor_email}` : ''}
                    </div>
                  </td>
                  <td>
                    {row.entity_type} #{row.entity_id}
                    {row.patient_name && <div className="muted small">patient: {row.patient_name}</div>}
                  </td>
                  <td>
                    <span className={`badge ${row.outcome === 'success' ? 'badge-ok' : 'badge-bad'}`}>{row.outcome}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                    >
                      {openRow === row.id ? 'Hide' : 'Inspect'}
                    </button>
                    {openRow === row.id && (
                      <div className="muted small mono" style={{ marginTop: '0.4rem', wordBreak: 'break-word' }}>
                        <div>request: {row.request_id || '—'}</div>
                        <div>ip: {row.ip_address || '—'}</div>
                        {row.user_agent && <div>ua: {row.user_agent}</div>}
                        {row.metadata && <div>metadata: {JSON.stringify(row.metadata)}</div>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <span>
              {data?.total ?? rows.length} entries · page {data?.page || 1} of {totalPages}
            </span>
            <span style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← Newer
              </button>
              <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Older →
              </button>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
