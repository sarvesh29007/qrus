/** Inline message banner. `kind`: error | success | info (default info). */
export default function Alert({ kind = 'info', title, children, onClose }) {
  const icon = kind === 'error' ? '⚠' : kind === 'success' ? '✓' : 'ℹ';
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="alert-icon" aria-hidden="true">{icon}</span>
      <div className="alert-body">
        {title && <strong className="alert-title">{title}</strong>}
        <div className="alert-text">{children}</div>
      </div>
      {onClose && (
        <button type="button" className="alert-close" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
