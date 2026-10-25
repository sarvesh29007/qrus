'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  zonedTimeToUtc,
  tzOffsetMs,
  dateStrInTz,
  todayInTz,
  addDays,
  isValidDateStr,
} = require('../src/utils/time');

test('zonedTimeToUtc converts clinic wall-clock to the correct instant (half-hour tz)', () => {
  // 09:00 in Kolkata (UTC+05:30) is 03:30 UTC on the same date.
  const instant = zonedTimeToUtc('2026-10-23', '09:00', 'Asia/Kolkata');
  assert.equal(instant.toISOString(), '2026-10-23T03:30:00.000Z');

  // Seconds are accepted too (DB TIME columns render as HH:MM:SS).
  assert.equal(
    zonedTimeToUtc('2026-10-23', '09:00:00', 'Asia/Kolkata').toISOString(),
    '2026-10-23T03:30:00.000Z'
  );
});

test('zonedTimeToUtc resolves the ambiguous hour around a DST fall-back', () => {
  // US DST ends 2026-11-01 (02:00 EDT -> 01:00 EST). 01:30 local resolves to
  // the *first* occurrence (EDT, UTC-04:00) because the naive instant before
  // adjustment is still inside EDT.
  const instant = zonedTimeToUtc('2026-11-01', '01:30', 'America/New_York');
  assert.equal(instant.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('tzOffsetMs reports zone offsets in milliseconds', () => {
  assert.equal(tzOffsetMs(new Date('2026-10-23T00:00:00Z'), 'Asia/Kolkata'), 5.5 * 3600 * 1000);
  assert.equal(tzOffsetMs(new Date('2026-01-15T00:00:00Z'), 'America/New_York'), -5 * 3600 * 1000);
});

test('dateStrInTz rolls the calendar day at the zone boundary', () => {
  const instant = new Date('2026-10-23T20:00:00Z');
  assert.equal(dateStrInTz(instant, 'UTC'), '2026-10-23');
  // 20:00Z is already 01:30 the next day in Kolkata.
  assert.equal(dateStrInTz(instant, 'Asia/Kolkata'), '2026-10-24');
});

test('todayInTz returns a valid clinic date', () => {
  const today = todayInTz('Asia/Kolkata');
  assert.ok(isValidDateStr(today));
});

test('addDays handles month, year and leap boundaries', () => {
  assert.equal(addDays('2026-10-23', 1), '2026-10-24');
  assert.equal(addDays('2026-10-23', -23), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // leap year
  assert.equal(addDays('2027-02-28', 1), '2027-03-01'); // common year
});

test('isValidDateStr accepts real dates only', () => {
  assert.ok(isValidDateStr('2026-10-23'));
  assert.ok(isValidDateStr('2028-02-29'));
  assert.ok(!isValidDateStr('2026-10-99'));
  assert.ok(!isValidDateStr('2026-1-1'));
  assert.ok(!isValidDateStr('not-a-date'));
});
