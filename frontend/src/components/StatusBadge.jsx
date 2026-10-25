const MAP = {
  // appointments
  pending: { label: 'Awaiting doctor', tone: 'warn' },
  scheduled: { label: 'Confirmed', tone: 'ok' },
  completed: { label: 'Completed', tone: 'neutral' },
  no_show: { label: 'No-show', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
  cancelled_by_patient: { label: 'Cancelled by you', tone: 'bad' },
  cancelled_by_doctor: { label: 'Cancelled by doctor', tone: 'bad' },
  cancelled_by_admin: { label: 'Cancelled by admin', tone: 'bad' },
  // waitlist
  waiting: { label: 'In queue', tone: 'warn' },
  matched: { label: 'Slot booked', tone: 'ok' },
  expired: { label: 'Expired', tone: 'neutral' },
  // reviews
  approved: { label: 'Published', tone: 'ok' },
  rejected: { label: 'Not published', tone: 'bad' },
  // slots
  open: { label: 'Available', tone: 'ok' },
  booked: { label: 'Taken', tone: 'bad' },
  blocked: { label: 'Blocked', tone: 'neutral' },
  // users
  active: { label: 'Active', tone: 'ok' },
  suspended: { label: 'Suspended', tone: 'bad' },
  inactive: { label: 'Inactive', tone: 'neutral' },
};

export default function StatusBadge({ status, label }) {
  const entry = MAP[status] || { label: status || '—', tone: 'neutral' };
  return <span className={`badge badge-${entry.tone}`}>{label || entry.label}</span>;
}
