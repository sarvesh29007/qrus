export default function Spinner({ label = 'Loading…', full = false }) {
  return (
    <div className={full ? 'spinner-wrap spinner-full' : 'spinner-wrap'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="spinner-label">{label}</span>
    </div>
  );
}
