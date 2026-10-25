import { useCallback, useEffect, useState } from 'react';
import { get } from '../api/client.js';
import useSlotEvents from '../hooks/useSlotEvents.js';
import Spinner from './Spinner.jsx';

const iso = (d) => d.toISOString().slice(0, 10);
const weekday = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];

/**
 * Doctor availability: a horizontal day strip plus the day's slot grid.
 * Selecting a slot calls `onSelect(slot)`; the parent decides whether that
 * means "book" or "show details". Every `slot_changed` SSE event reloads the
 * visible day, so a slot taken by someone else disappears live.
 */
export default function SlotGrid({ doctorId, selectedDate, onSelect, disabled = false, readOnly = false }) {
  const [days, setDays] = useState([]);
  const [date, setDate] = useState(selectedDate || iso(new Date()));
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Next 14 days in the day strip (Sundays are simply shown as empty days).
  useEffect(() => {
    const base = new Date();
    setDays(
      Array.from({ length: 14 }, (_, i) => {
        const d = new Date(base.getTime() + i * 86400000);
        return { date: iso(d), label: weekday(d), day: d.getUTCDate(), today: i === 0 };
      })
    );
  }, []);

  useEffect(() => setDate(selectedDate || date), [selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!doctorId || !date) return;
    setLoading(true);
    setError('');
    try {
      const data = await get(`/doctors/${doctorId}/slots?date=${date}`);
      setSlots(data.slots || []);
    } catch (err) {
      setError(err.message);
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [doctorId, date]);

  useEffect(() => {
    load();
  }, [load]);

  useSlotEvents(load);

  const openCount = slots.filter((s) => s.available).length;

  return (
    <div className="slot-grid">
      <div className="day-strip" role="tablist" aria-label="Choose a date">
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            role="tab"
            aria-selected={d.date === date}
            className={`day-chip${d.date === date ? ' is-active' : ''}`}
            onClick={() => setDate(d.date)}
          >
            <small>{d.label}</small>
            <strong>{d.day}</strong>
          </button>
        ))}
      </div>

      <div className="slot-grid-head">
        <span className="muted">
          {new Date(`${date}T00:00:00Z`).toUTCString().slice(0, 16)} ·{' '}
          {loading ? 'loading…' : `${openCount} of ${slots.length} slots free`}
        </span>
        <span className="live-dot" title="Live availability via server-sent events" />
      </div>

      {error && <p className="form-error">{error}</p>}
      {loading ? (
        <Spinner label="Loading availability…" />
      ) : slots.length === 0 ? (
        <p className="empty-note">The clinic is closed on this day — try another date.</p>
      ) : (
        <div className="slot-list">
          {slots.map((slot) => {
            const mine = Boolean(slot.myAppointmentId);
            const canPick = !readOnly && slot.available && !disabled;
            return (
              <button
                key={slot.id}
                type="button"
                className={`slot${
                  canPick ? ' slot-open' : ''
                }${mine ? ' slot-mine' : ''}${!slot.available && !mine ? ' slot-taken' : ''}`}
                disabled={!canPick}
                onClick={() => canPick && onSelect(slot)}
                title={
                  mine
                    ? `Your appointment (${slot.myAppointmentStatus})`
                    : slot.available
                      ? 'Book this slot'
                      : slot.past
                        ? 'This time has already passed'
                        : 'Already booked or blocked'
                }
              >
                <span className="slot-time">{slot.start}</span>
                <span className="slot-state">
                  {mine ? 'Yours' : slot.available ? 'Open' : slot.past ? 'Passed' : slot.status === 'blocked' ? 'Blocked' : 'Taken'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
