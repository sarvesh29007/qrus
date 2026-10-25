import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get } from '../../api/client.js';
import Spinner from '../../components/Spinner.jsx';
import Alert from '../../components/Alert.jsx';
import DoctorCard from '../../components/DoctorCard.jsx';
import SymptomMatcher from '../../components/SymptomMatcher.jsx';

/**
 * Patient doctor search: filters + results, with the symptom matcher on top.
 * The matcher hands its recommendation back by setting `?specialtyId=`, so the
 * same page shows "these cardiologists" without a second screen.
 */
export default function FindCare() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [specialties, setSpecialties] = useState([]);
  const [filters, setFilters] = useState({
    q: '',
    specialtyId: searchParams.get('specialtyId') || '',
    city: '',
    sort: 'rating',
  });
  const [doctors, setDoctors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [matchedSpecialty, setMatchedSpecialty] = useState(null);

  useEffect(() => {
    get('/specialties')
      .then((data) => setSpecialties(data.specialties || []))
      .catch(() => setSpecialties([]));
  }, []);

  // specialtyId may change from the matcher (URL) or the dropdown (state).
  useEffect(() => {
    const fromUrl = searchParams.get('specialtyId') || '';
    setFilters((prev) => (prev.specialtyId === fromUrl ? prev : { ...prev, specialtyId: fromUrl }));
  }, [searchParams]);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.specialtyId) params.set('specialtyId', filters.specialtyId);
      if (filters.city.trim()) params.set('city', filters.city.trim());
      params.set('sort', filters.sort);
      params.set('limit', '12');
      const data = await get(`/doctors?${params.toString()}`);
      setDoctors(data.doctors || []);
    } catch (err) {
      setError(err.message);
      setDoctors([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const timer = setTimeout(runSearch, filters.q ? 300 : 0); // debounce typing
    return () => clearTimeout(timer);
  }, [runSearch, filters.q]);

  function update(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    if (key === 'specialtyId') {
      const next = new URLSearchParams(searchParams);
      if (value) next.set('specialtyId', value);
      else next.delete('specialtyId');
      setSearchParams(next, { replace: true });
      setMatchedSpecialty(null);
    }
  }

  function pickSpecialty(specialty) {
    setMatchedSpecialty(specialty);
    update('specialtyId', String(specialty.id));
    document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const activeSpecialty = specialties.find((s) => String(s.id) === String(filters.specialtyId));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Find care</h1>
          <p>Search the directory, or describe your symptoms and let Qrus route you to the right specialty.</p>
        </div>
      </div>

      <SymptomMatcher onPickSpecialty={pickSpecialty} />

      <section className="section" id="results" style={{ marginTop: '1.5rem' }}>
        <div className="filter-bar">
          <div className="filter-field">
            <label htmlFor="q">Doctor, clinic or condition</label>
            <input
              id="q"
              value={filters.q}
              onChange={(e) => update('q', e.target.value)}
              placeholder="e.g. Meera, back pain, Pune"
            />
          </div>
          <div className="filter-field">
            <label htmlFor="specialty">Specialty</label>
            <select id="specialty" value={filters.specialtyId} onChange={(e) => update('specialtyId', e.target.value)}>
              <option value="">All specialties</option>
              {specialties.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="city">City</label>
            <input id="city" value={filters.city} onChange={(e) => update('city', e.target.value)} placeholder="Any city" />
          </div>
          <div className="filter-field">
            <label htmlFor="sort">Sort by</label>
            <select id="sort" value={filters.sort} onChange={(e) => update('sort', e.target.value)}>
              <option value="rating">Patient rating</option>
              <option value="experience">Experience</option>
              <option value="fee">Consultation fee</option>
            </select>
          </div>
        </div>

        {matchedSpecialty && (
          <Alert kind="success" title={`Routed to ${matchedSpecialty.name}`} onClose={() => setMatchedSpecialty(null)}>
            These doctors match your symptoms best. Pick one to see live availability.
          </Alert>
        )}
        {activeSpecialty && !matchedSpecialty && (
          <p className="muted small">
            Filtering by <strong>{activeSpecialty.name}</strong>.{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => update('specialtyId', '')}
            >
              Clear filter
            </button>
          </p>
        )}

        {error && <Alert kind="error" onClose={() => setError('')}>{error}</Alert>}

        {loading ? (
          <Spinner label="Searching doctors…" />
        ) : doctors.length === 0 ? (
          <p className="empty-note">No doctors match those filters — try widening the search.</p>
        ) : (
          <div className="grid grid-3">
            {doctors.map((doctor) => (
              <DoctorCard key={doctor.id} doctor={doctor} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
