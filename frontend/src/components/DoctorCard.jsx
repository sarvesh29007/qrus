import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge.jsx';

export function Stars({ value = 0, count = 0 }) {
  if (!count) return <span className="muted">No reviews yet</span>;
  const rounded = Math.round(value);
  return (
    <span className="stars" title={`${value.toFixed(1)} / 5 from ${count} verified patient${count === 1 ? '' : 's'}`}>
      <span aria-hidden="true">{'★'.repeat(rounded)}{'☆'.repeat(5 - rounded)}</span>
      <small>
        {value.toFixed(1)} ({count})
      </small>
    </span>
  );
}

/** Search-result card for the patient "Find care" grid. */
export default function DoctorCard({ doctor }) {
  return (
    <article className="doctor-card">
      <header className="doctor-card-head">
        <span className="doctor-avatar" aria-hidden="true">
          {doctor.name?.replace(/^Dr\s+/i, '').charAt(0)}
        </span>
        <div>
          <h3>{doctor.name}</h3>
          <p className="doctor-specialty">{doctor.specialty_name}</p>
        </div>
        {!doctor.accepting_new_patients && <StatusBadge status="inactive" label="Not taking patients" />}
      </header>

      <dl className="doctor-facts">
        <div>
          <dt>Clinic</dt>
          <dd>{doctor.clinic_name || '—'}</dd>
        </div>
        <div>
          <dt>City</dt>
          <dd>{doctor.city || '—'}</dd>
        </div>
        <div>
          <dt>Experience</dt>
          <dd>{doctor.years_experience} yrs</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>₹{doctor.consultation_fee}</dd>
        </div>
      </dl>

      <footer className="doctor-card-foot">
        <Stars value={doctor.rating_avg || 0} count={doctor.rating_count || 0} />
        <span className="muted">
          {doctor.nextAvailableDate ? `Next free: ${doctor.nextAvailableDate}` : 'No open slots in the next 2 weeks'}
        </span>
        <Link className="btn btn-primary btn-sm" to={`/patient/doctors/${doctor.id}`}>
          View &amp; book
        </Link>
      </footer>
    </article>
  );
}
