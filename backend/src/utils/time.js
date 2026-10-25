'use strict';

/**
 * Timezone helpers.
 *
 * Doctor schedules are written as clinic wall-clock times ("09:00" on
 * "2026-10-22"). Slots additionally carry an absolute TIMESTAMPTZ instant so
 * ordering, "is this in the past" checks and SSE broadcasts are unambiguous.
 * These two helpers convert between the two representations using a real IANA
 * timezone (DST-safe).
 */

const dtfCache = new Map();

function getFormatter(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

/** Offset of `timeZone` relative to UTC at the given instant, in ms. */
function tzOffsetMs(date, timeZone) {
  const parts = getFormatter(timeZone).formatToParts(date);
  const map = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  const floored = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - floored;
}

/**
 * Convert clinic wall-clock time to an absolute instant.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} timeStr 'HH:MM' | 'HH:MM:SS'
 * @param {string} timeZone IANA name, e.g. 'America/New_York'
 * @returns {Date}
 */
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const normalized = /^\d{2}:\d{2}$/.test(timeStr) ? `${timeStr}:00` : timeStr;
  const naiveUtc = Date.parse(`${dateStr}T${normalized}Z`);
  if (Number.isNaN(naiveUtc)) throw new Error(`Invalid date/time: ${dateStr} ${timeStr}`);

  const offset1 = tzOffsetMs(new Date(naiveUtc), timeZone);
  const guess = new Date(naiveUtc - offset1);
  const offset2 = tzOffsetMs(guess, timeZone);
  return new Date(naiveUtc - offset2);
}

/** Format an absolute instant in a timezone -> 'YYYY-MM-DD'. */
function formatInTz(date, timeZone, options = {}) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, ...options }).format(date);
}

/** 'YYYY-MM-DD' for an absolute instant in the clinic timezone. */
function dateStrInTz(date, timeZone) {
  return formatInTz(date, timeZone);
}

/** Today's clinic date as 'YYYY-MM-DD'. */
function todayInTz(timeZone) {
  return formatInTz(new Date(), timeZone);
}

/** Add n calendar days to a 'YYYY-MM-DD' string. */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !Number.isNaN(Date.parse(`${dateStr}T00:00:00Z`));
}

module.exports = { zonedTimeToUtc, tzOffsetMs, formatInTz, dateStrInTz, todayInTz, addDays, isValidDateStr };
