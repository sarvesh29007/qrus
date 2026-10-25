import { useCallback, useEffect, useState } from 'react';
import { del, get, post, put } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';

const DAYS = [
  { id: 1, label: 'Monday' },
  { id: 2, label: 'Tuesday' },
  { id: 3, label: 'Wednesday' },
  { id: 4, label: 'Thursday' },
  { id: 5, label: 'Friday' },
  { id: 6, label: 'Saturday' },
  { id: 0, label: 'Sunday' },
];

/**
 * Weekly recurring schedule editor + per-date overrides.
 * Every mutation regenerates concrete slots on the server, so the response's
 * `regeneratedDates` are surfaced to the doctor.
 */
export default function DoctorSchedule() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(null); // weekday being edited
  const [window, setWindow] = useState({ startTime: '09:00', endTime: '12:00', slotMinutes: 20 });

  const [override, setOverride] = useState({
    date: '',
    isAvailable: false,
    startTime: '',
    endTime: '',
    reason: '',
  });

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await get('/doctor/schedule'));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function describeDates(res) {
    const dates = res?.regeneratedDates || [];
    if (!dates.length) return null;
    const shown = dates.slice(0, 4).join(', ');
    return `Slots regenerated for ${shown}${dates.length > 4 ? ` +${dates.length - 4} more` : ''}.`;
  }

  async function addWindow(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const res = await put('/doctor/schedule', {
        weekday: adding,
        startTime: window.startTime,
        endTime: window.endTime,
        slotMinutes: Number(window.slotMinutes),
      });
      setNotice({ kind: 'success', text: `Clinic window added. ${describeDates(res) || ''}`.trim() });
      setAdding(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeWindow(win) {
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const res = await del(`/doctor/schedule/${win.id}`);
      setNotice({ kind: 'success', text: `Window removed. ${describeDates(res) || ''}`.trim() });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addOverride(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const payload = {
        date: override.date,
        isAvailable: override.isAvailable,
        reason: override.reason.trim(),
      };
      if (override.startTime && override.endTime) {
        payload.startTime = override.startTime;
        payload.endTime = override.endTime;
      }
      const res = await post('/doctor/overrides', payload);
      setNotice({
        kind: 'success',
        text: `${override.isAvailable ? 'Extra hours' : 'Block'} saved for ${override.date}. ${
          describeDates(res) || ''
        }`.trim(),
      });
      setOverride({ date: '', isAvailable: false, startTime: '', endTime: '', reason: '' });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeOverride(item) {
    setBusy(true);
    setError('');
    try {
      const res = await del(`/doctor/overrides/${item.id}`);
      setNotice({ kind: 'success', text: `Override removed for ${item.override_date}. ${describeDates(res) || ''}`.trim() });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Spinner label="Loading your schedule…" full />;

  const byWeekday = {};
  for (const win of data.windows) {
    (byWeekday[win.weekday] = byWeekday[win.weekday] || []).push(win);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedule</h1>
          <p>
            Recurring clinic hours generate bookable slots automatically; overrides handle holidays, extra clinics or
            partial days. Slots are regenerated the moment you save.
          </p>
        </div>
      </div>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && (
        <Alert kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Weekly pattern</h2>
          <span className="muted small">{data.windows.length} recurring window(s)</span>
        </div>

        <div className="schedule-grid">
          {DAYS.map((day) => (
            <div key={day.id} className="schedule-day">
              <h3>{day.label}</h3>

              {(byWeekday[day.id] || []).length === 0 && adding !== day.id && (
                <p className="muted small">No clinic hours.</p>
              )}

              {(byWeekday[day.id] || []).map((win) => (
                <div key={win.id} className="window-row">
                  <span className="window-time">
                    {win.start_time} – {win.end_time}
                  </span>
                  <span className="window-meta">{win.slot_minutes} min</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => removeWindow(win)}
                    aria-label={`Remove ${day.label} ${win.start_time} window`}
                  >
                    ×
                  </button>
                </div>
              ))}

              {adding === day.id ? (
                <form className="window-form" onSubmit={addWindow}>
                  <div className="form-field">
                    <label htmlFor={`start-${day.id}`}>Start</label>
                    <input
                      id={`start-${day.id}`}
                      type="time"
                      value={window.startTime}
                      onChange={(e) => setWindow({ ...window, startTime: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={`end-${day.id}`}>End</label>
                    <input
                      id={`end-${day.id}`}
                      type="time"
                      value={window.endTime}
                      onChange={(e) => setWindow({ ...window, endTime: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={`slot-${day.id}`}>Min</label>
                    <select
                      id={`slot-${day.id}`}
                      value={window.slotMinutes}
                      onChange={(e) => setWindow({ ...window, slotMinutes: e.target.value })}
                    >
                      {[10, 15, 20, 30, 45, 60].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
                    Save
                  </button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding(null)} disabled={busy}>
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: '0.55rem' }}
                  onClick={() => {
                    setAdding(day.id);
                    setWindow({ startTime: '09:00', endTime: '12:00', slotMinutes: 20 });
                  }}
                >
                  + Add window
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Date overrides</h2>
          <span className="muted small">next 60 days</span>
        </div>

        <div className="detail-grid">
          <div className="card">
            {data.overrides.length === 0 ? (
              <p className="empty-note">No overrides — every date follows your weekly pattern.</p>
            ) : (
              data.overrides.map((item) => (
                <div key={item.id} className="override-row">
                  <div>
                    <strong>{item.override_date}</strong>{' '}
                    <span className={`badge ${item.is_available ? 'badge-ok' : 'badge-bad'}`}>
                      {item.is_available ? 'Extra clinic' : 'Blocked'}
                    </span>
                    {item.start_time && (
                      <span className="muted small">
                        {' '}
                        {item.start_time} – {item.end_time}
                      </span>
                    )}
                    {item.reason && <div className="muted small">{item.reason}</div>}
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={() => removeOverride(item)} disabled={busy}>
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <form className="card" onSubmit={addOverride}>
            <div className="card-head">
              <h2>Add an override</h2>
            </div>

            <div className="form-field">
              <label htmlFor="ovDate">Date</label>
              <input
                id="ovDate"
                type="date"
                value={override.date}
                onChange={(e) => setOverride({ ...override, date: e.target.value })}
                required
              />
            </div>

            <div className="form-field">
              <label htmlFor="ovKind">Type</label>
              <select
                id="ovKind"
                value={override.isAvailable ? 'open' : 'block'}
                onChange={(e) => setOverride({ ...override, isAvailable: e.target.value === 'open' })}
              >
                <option value="block">Block the day (holiday / leave)</option>
                <option value="open">Add extra hours</option>
              </select>
            </div>

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="ovStart">From (optional)</label>
                <input
                  id="ovStart"
                  type="time"
                  value={override.startTime}
                  onChange={(e) => setOverride({ ...override, startTime: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label htmlFor="ovEnd">To (optional)</label>
                <input
                  id="ovEnd"
                  type="time"
                  value={override.endTime}
                  onChange={(e) => setOverride({ ...override, endTime: e.target.value })}
                />
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="ovReason">Reason</label>
              <input
                id="ovReason"
                value={override.reason}
                onChange={(e) => setOverride({ ...override, reason: e.target.value })}
                placeholder="e.g. Conference travel"
                maxLength={200}
                required={!override.isAvailable && !override.startTime}
              />
            </div>

            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save override'}
            </button>
          </form>
        </div>
      </section>
    </>
  );
}
