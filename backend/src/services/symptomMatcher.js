'use strict';

const { query } = require('../config/db');

/**
 * =============================================================================
 * Symptom -> Specialty routing engine
 * =============================================================================
 *
 * Pipeline:
 *   1. NORMALISE  lowercase, strip punctuation, collapse whitespace.
 *   2. NEGATION   "no chest pain" / "without fever" — the two tokens after a
 *                 negator are masked so they cannot route anywhere.
 *   3. N-GRAM     generate 1..4 token candidates (raw and lightly stemmed).
 *   4. MATCH      longest match wins: a hit marks its token span as consumed,
 *                 so "chest pain" scores once and its parts do not double count.
 *   5. SCORE      weight * specificity bonus, summed per specialty.
 *   6. TRIAGE     red-flag phrases escalate the recommendation to emergency.
 *
 * The vocabulary lives in `symptom_rules` (database/seed.sql), so admins can
 * add terms and weights without a deploy. Results are cached briefly because
 * the rule set changes rarely and the endpoint is hit on every keystroke-ish
 * search.
 */

const MAX_NGRAM = 4;
const SPECIFICITY_BONUS = 0.15; // per extra token in a matched phrase
const NEGATORS = new Set([
  'no', 'not', 'without', 'denies', 'denied', 'never', 'dont', "don't",
  'doesnt', "doesn't", 'cant', "can't", 'isnt', 'except', 'negative for',
]);

/** Phrases that must never be routed to a routine outpatient slot. */
const RED_FLAGS = [
  'suicidal thoughts', 'self harm', 'chest pain', 'coughing blood',
  'blood in stool', 'vision loss', 'seizure', 'slurred speech',
  'blue lips', 'weakness in one side', 'fainting', 'blood in urine',
  'severe headache', 'difficulty breathing', 'loss of consciousness',
];

// ---------------------------------------------------------------------------
// Rule cache
// ---------------------------------------------------------------------------
let cache = { at: 0, terms: null, specialties: null };
const CACHE_TTL_MS = 60_000;

function invalidateRuleCache() {
  cache = { at: 0, terms: null, specialties: null };
}

async function loadRules(force = false) {
  if (!force && cache.terms && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  const [rulesRes, specRes] = await Promise.all([
    query(
      `SELECT r.specialty_id, lower(r.term) AS term, r.weight::float AS weight
         FROM symptom_rules r
         JOIN specialties s ON s.id = r.specialty_id
        WHERE r.is_active AND s.is_active`
    ),
    query(
      `SELECT id, slug, name, description, icon
         FROM specialties WHERE is_active ORDER BY name`
    ),
  ]);

  // term -> [{ specialtyId, weight }]
  const terms = new Map();
  for (const row of rulesRes.rows) {
    const key = normalise(row.term);
    if (!key) continue;
    if (!terms.has(key)) terms.set(key, []);
    terms.get(key).push({ specialtyId: row.specialty_id, weight: row.weight });
  }

  const specialties = new Map(specRes.rows.map((s) => [s.id, s]));
  cache = { at: Date.now(), terms, specialties };
  return cache;
}

// ---------------------------------------------------------------------------
// Text processing
// ---------------------------------------------------------------------------
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cheap singulariser: "pains" -> "pain", but leaves "chest"/"knees" alone. */
function stem(token) {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses') || token.endsWith('shes') || token.endsWith('ches')) {
    return token.slice(0, -2);
  }
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/** @returns {{ tokens: string[], stems: string[], masked: Set<number> }} */
function tokenize(input) {
  const normalised = normalise(input);
  const raw = normalised ? normalised.split(' ') : [];
  const tokens = raw.slice(0, 80);
  const stems = tokens.map(stem);

  const masked = new Set();
  tokens.forEach((token, i) => {
    if (!NEGATORS.has(token)) return;
    masked.add(i);
    if (i + 1 < tokens.length) masked.add(i + 1);
    if (i + 2 < tokens.length) masked.add(i + 2);
  });

  return { tokens, stems, masked };
}

// ---------------------------------------------------------------------------
// Matching + scoring
// ---------------------------------------------------------------------------
/**
 * @param {string} input  free-text symptoms, or an array of phrases
 * @param {object} [options]
 * @param {boolean} [options.withTriage]
 * @returns {Promise<object>}
 */
async function matchSymptoms(input, options = {}) {
  const text = Array.isArray(input) ? input.join(', ') : input;
  const { terms, specialties } = await loadRules();

  const { tokens, stems, masked } = tokenize(text);
  const matchedBySpan = []; // { start, end, term, weight, specialtyIds }
  const consumed = new Set(); // token indexes already explained by a longer match

  const candidates = [];
  for (let n = MAX_NGRAM; n >= 1; n -= 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const span = [];
      let maskedHit = false;
      for (let k = i; k < i + n; k += 1) {
        if (masked.has(k)) maskedHit = true;
        span.push(k);
      }
      if (maskedHit) continue;
      if (span.some((k) => consumed.has(k))) continue;

      const phrase = tokens.slice(i, i + n).join(' ');
      const phraseStem = stems.slice(i, i + n).join(' ');
      const hit = terms.get(phrase) || terms.get(phraseStem);
      if (!hit) continue;

      candidates.push({ start: i, end: i + n, phrase, hit });
      span.forEach((k) => consumed.add(k));
    }
  }

  // Score per specialty.
  const scores = new Map(); // specialtyId -> { score, matched: Map<term, {weight, phrase}> }
  for (const c of candidates) {
    const bonus = 1 + SPECIFICITY_BONUS * (c.phrase.split(' ').length - 1);
    for (const rule of c.hit) {
      if (!scores.has(rule.specialtyId)) {
        scores.set(rule.specialtyId, { score: 0, matched: new Map() });
      }
      const bucket = scores.get(rule.specialtyId);
      bucket.score += rule.weight * bonus;
      const existing = bucket.matched.get(normalise(c.phrase));
      if (!existing || existing.weight < rule.weight) {
        bucket.matched.set(normalise(c.phrase), {
          weight: rule.weight,
          phrase: c.phrase,
        });
      }
      matchedBySpan.push({ phrase: c.phrase, specialtyId: rule.specialtyId });
    }
  }

  const ranked = [...scores.entries()]
    .map(([specialtyId, data]) => ({
      specialty: toPublicSpecialty(specialties.get(specialtyId), specialtyId),
      score: round(data.score),
      matchedTerms: [...data.matched.values()]
        .sort((a, b) => b.weight - a.weight)
        .map((m) => m.phrase),
    }))
    .filter((entry) => entry.specialty)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Confidence is the share of the total routing score this specialty holds:
  // 1.0 when it is the only candidate, decaying as alternatives gain weight.
  const total = ranked.reduce((sum, r) => sum + r.score, 0) || 1;
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
    entry.confidence = round(entry.score / total);
  });

  // Nothing matched the vocabulary: fall back to primary care, honestly
  // labelled as a guess rather than pretending it is a confident route.
  if (!ranked.length) {
    const general = [...specialties.values()].find((s) => s.slug === 'general-medicine');
    if (general) {
      ranked.push({
        specialty: toPublicSpecialty(general),
        score: 0,
        matchedTerms: [],
        rank: 1,
        confidence: 0,
      });
    }
  }

  const result = {
    normalisedQuery: normalise(text),
    matches: ranked,
    analysedTerms: tokens.filter((t, i) => !masked.has(i)).slice(0, 40),
    maskedTerms: tokens.filter((t, i) => masked.has(i)),
  };

  if (options.withTriage !== false) {
    result.triage = triage(ranked, matchedBySpan);
  }

  return result;
}

function triage(ranked, matchedBySpan) {
  const fired = new Set(matchedBySpan.map((m) => normalise(m.phrase)));
  const redFlag = RED_FLAGS.find(
    (flag) => fired.has(flag) || [...fired].some((t) => t.includes(flag))
  );

  if (redFlag) {
    return {
      level: 'emergency',
      term: redFlag,
      advice:
        'Your description includes a red-flag symptom. Please seek urgent or emergency medical care now rather than waiting for an outpatient appointment.',
    };
  }
  if (!ranked.length || ranked[0].confidence < 0.25) {
    return {
      level: 'low',
      advice:
        'We could not confidently match these symptoms to a specialty. A General Medicine consultation is a sensible first step.',
    };
  }
  return {
    level: 'routine',
    advice: 'These symptoms map cleanly to the recommended specialty below.',
  };
}

function toPublicSpecialty(row, fallbackId) {
  if (!row) return null;
  return {
    id: row.id ?? fallbackId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { matchSymptoms, invalidateRuleCache, normalise, stem, tokenize, RED_FLAGS };
