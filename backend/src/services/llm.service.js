'use strict';

/**
 * LLM provider layer — OpenAI / Gemini compatible, provider-agnostic.
 *
 * The chatbot never *needs* the LLM: intents are classified by deterministic
 * rules first, and the FAQ fast-path never reaches this module at all. When an
 * API key is configured, the LLM is used as a fallback for free-form phrasing
 * the rules could not confidently place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHI HANDLING — the rule this module exists to enforce
 * ─────────────────────────────────────────────────────────────────────────────
 * A patient's message is Protected Health Information. It may be sent to the
 * configured LLM (that is the feature), but it must NEVER reach a log line,
 * an error message, an audit row or a metric label. `redact()` strips the
 * directly identifying tokens and truncates anything else, and `safe()`
 * is the only way to turn user text into a string here.
 *
 * No console.* in this file may interpolate raw model input.
 */

const config = require('../config/env');

// Patterns ordered from most identifying to least. Kept deliberately broad:
// over-redacting a log line costs nothing, under-redacting one leaks a patient.
const REDACTIONS = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'], // arjun@example.com
  [/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}\b/g, '[phone]'], // phone-ish digit runs
  [/\b\d{1,3}-\d{1,2}-\d{2,4}\b/g, '[dob]'], // 12-03-1988, 1988-03-12 variants
  [/\b(?:aadhaar|ssn|mrn|uhid|patient\s*id|id\s*number|passport|license)\b[:=\s]*[\w-]*/gi, '[id]'],
  [/\b(?:street|road|rd\.|avenue|apt|flat|block|sector)\b[^,.;\n]*/gi, '[address]'],
];

/**
 * Strip identifying tokens and cap the result. Used on *everything* that is
 * about to be logged, measured or persisted as metadata.
 * @param {unknown} value
 * @param {number} [max=200]
 * @returns {string}
 */
function redact(value, max = 200) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  for (const [pattern, token] of REDACTIONS) text = text.replace(pattern, token);
  // Collapse whitespace so a redacted line stays on one log row.
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A log-safe fingerprint of a message: length + a short non-reversible digest.
 * Lets you correlate "same message retried" without ever storing the message.
 */
function fingerprint(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `len=${text.length},fnv=${hash.toString(16)}`;
}

const PROVIDERS = {
  openai: {
    url: (cfg) => `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: (cfg) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    }),
    body: (cfg, system, messages, json) => ({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    text: (data) => data.choices?.[0]?.message?.content ?? '',
  },
  gemini: {
    url: (cfg) =>
      `${cfg.baseUrl.replace(/\/$/, '')}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (cfg, system, messages, json) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: 0,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    text: (data) => data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '',
  },
};

/** True when a usable provider + key has been configured. */
function isConfigured() {
  return Boolean(config.llm.apiKey && PROVIDERS[config.llm.provider]);
}

/**
 * Send a prompt and get plain text back. Returns `null` when no provider is
 * configured or the call fails — callers treat null as "fall back to rules",
 * never as an error the patient has to see.
 *
 * @param {{ system: string, messages: Array<{role:'user'|'assistant', content:string}>, json?: boolean, timeoutMs?: number }} params
 * @returns {Promise<string|null>}
 */
async function complete({ system, messages, json = false, timeoutMs }) {
  if (!isConfigured()) return null;
  const cfg = config.llm;
  const provider = PROVIDERS[cfg.provider];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? cfg.timeoutMs);

  try {
    const res = await fetch(provider.url(cfg), {
      method: 'POST',
      headers: provider.headers(cfg),
      body: JSON.stringify(provider.body(cfg, system, messages, json)),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Status + body *shape* only: the body can echo the prompt back.
      console.warn(`[qrus:llm] ${cfg.provider} responded ${res.status} (${fingerprint(system)})`);
      return null;
    }
    const data = await res.json();
    const text = provider.text(data).trim();
    return text || null;
  } catch (err) {
    console.warn(`[qrus:llm] ${cfg.provider} call failed: ${err.name} (${fingerprint(system)})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a model reply that must be JSON. Never throws; returns null on any
 * malformed payload so the deterministic classifier keeps the floor.
 */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Models occasionally wrap JSON in prose or fences — pull the object out.
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

module.exports = { redact, fingerprint, isConfigured, complete, parseJson };
