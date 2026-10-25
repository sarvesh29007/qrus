import { useState } from 'react';
import { post } from '../api/client.js';
import Alert from './Alert.jsx';

const TRIAGE_TONE = { routine: 'info', soon: 'warn', emergency: 'error' };

/**
 * Intelligent symptom -> specialty routing UI. Submits free text to
 * POST /api/match/symptoms and renders the ranked recommendations with the
 * matched terms and the triage hint. `onPickSpecialty(specialty)` lets the
 * host page (Find care / Overview) jump straight into that specialty's doctors.
 */
export default function SymptomMatcher({ onPickSpecialty }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    const symptoms = text.trim();
    if (symptoms.length < 3) {
      setError('Describe your symptoms in a few words (at least 3 characters).');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await post('/match/symptoms', { symptoms, includeTriage: true });
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="matcher card">
      <header className="card-head">
        <h2>What brings you in?</h2>
        <p className="muted">Describe symptoms in plain language — Qrus routes you to the right specialty.</p>
      </header>

      <form className="matcher-form" onSubmit={handleSubmit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="e.g. chest tightness when climbing stairs, mild breathlessness, occasional palpitations"
          aria-label="Your symptoms"
        />
        <div className="matcher-actions">
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Analysing…' : 'Match to a specialty'}
          </button>
          {result && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setText('');
                setResult(null);
              }}
            >
              Clear
            </button>
          )}
        </div>
      </form>

      {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

      {result && (
        <div className="matcher-result">
          {result.triage && (
            <Alert kind={TRIAGE_TONE[result.triage.level] || 'info'} title={`Triage: ${result.triage.level}`}>
              {result.triage.advice}
            </Alert>
          )}

          <p className="muted small">
            Analysed terms: {result.analysedTerms?.join(', ') || '—'}
            {result.maskedTerms?.length ? ` · withheld: ${result.maskedTerms.join(', ')}` : ''}
          </p>

          <ol className="match-list">
            {(result.matches || []).slice(0, 4).map((m) => (
              <li key={m.specialty.id} className={`match-item${m.rank === 1 ? ' is-top' : ''}`}>
                <div className="match-rank">#{m.rank}</div>
                <div className="match-body">
                  <strong>{m.specialty.name}</strong>
                  <p className="muted small">{m.specialty.description}</p>
                  <div className="match-terms">
                    {m.matchedTerms.map((t) => (
                      <span key={t} className="tag tag-soft">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="match-score">
                  <strong>{(m.score * 10).toFixed(0)}</strong>
                  <small>score</small>
                  {onPickSpecialty && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onPickSpecialty(m.specialty)}
                    >
                      See doctors
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
