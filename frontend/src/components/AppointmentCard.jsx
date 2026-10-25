import StatusBadge from './StatusBadge.jsx';

/**
 * One appointment row. `children` render inside the action bar, so the same
 * card serves the patient list (cancel/reschedule/review) and the doctor queue
 * (accept/decline/complete) without duplicating the clinical summary.
 */
export default function AppointmentCard({ appointment, title, subtitle, showSymptoms = true, children }) {
  const a = appointment;
  return (
    <article className="appt-card">
      <div className="appt-when">
        <strong>{a.scheduled_date}</strong>
        <span>{a.scheduled_time}</span>
      </div>

      <div className="appt-main">
        <header className="appt-head">
          <h3>{title || `Appointment #${a.id}`}</h3>
          <StatusBadge status={a.status} />
        </header>
        {subtitle && <p className="appt-sub">{subtitle}</p>}
        {a.reason && (
          <p className="appt-reason">
            <span className="tag">Reason</span> {a.reason}
          </p>
        )}
        {showSymptoms && a.symptoms && (
          <details className="appt-symptoms">
            <summary>Patient-reported symptoms</summary>
            <p>{a.symptoms}</p>
          </details>
        )}
        {a.cancellation_reason && (
          <p className="muted small">
            Cancellation note: {a.cancellation_reason}
          </p>
        )}
        {children && <div className="appt-actions">{children}</div>}
      </div>
    </article>
  );
}
