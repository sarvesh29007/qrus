'use strict';

/**
 * Thin fetch wrapper for the Qrus API.
 *
 * - Attaches the bearer access token.
 * - Transparently refreshes once on 401 and replays the request.
 * - Always throws an `ApiError` carrying { status, code, message, details } so
 *   components can render the server's redacted error envelope directly.
 * - Tokens live in localStorage: convenient for a demo SPA, and noted here
 *   because production healthcare apps should prefer httpOnly cookies.
 */

const ACCESS_KEY = 'qrus.access';
const REFRESH_KEY = 'qrus.refresh';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'ERROR';
    this.details = details || null;
  }
}

export const tokens = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access, refresh) {
    if (access) localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

let refreshInFlight = null;

async function tryRefresh() {
  const refresh = tokens.refresh;
  if (!refresh) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      tokens.set(data.accessToken, data.refreshToken);
      return true;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function parse(res) {
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    const err = body && body.error ? body.error : {};
    throw new ApiError(res.status, err.code, err.message || `Request failed (${res.status}).`, err.details);
  }
  return body;
}

/**
 * api('/appointments', { method: 'POST', body: {...} })
 * Use `auth: false` for public endpoints; `raw: true` returns the Response
 * (needed for the SSE stream).
 */
export async function api(path, { method = 'GET', body, auth = true, raw = false, headers = {} } = {}) {
  const doFetch = () => {
    const init = {
      method,
      headers: { Accept: 'application/json', ...headers },
      credentials: 'same-origin',
    };
    if (body !== undefined) init.headers['Content-Type'] = 'application/json';
    const access = tokens.access;
    if (auth && access) init.headers.Authorization = `Bearer ${access}`;
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(path.startsWith('/api') ? path : `/api${path}`, init);
  };

  let res = await doFetch();

  if (res.status === 401 && auth && tokens.refresh) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await doFetch();
  }

  if (raw) {
    if (!res.ok) await parse(res);
    return res;
  }
  return parse(res);
}

/** Convenience verbs. */
export const get = (path, opts) => api(path, { ...opts, method: 'GET' });
export const post = (path, body, opts) => api(path, { ...opts, method: 'POST', body });
export const patch = (path, body, opts) => api(path, { ...opts, method: 'PATCH', body });
export const put = (path, body, opts) => api(path, { ...opts, method: 'PUT', body });
export const del = (path, opts) => api(path, { ...opts, method: 'DELETE' });
