import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LeapSecondTable,
  parseLeapSecondTable,
  parseNtpEraFile,
  LeapSecondError,
} from '../src/index.js';

// A small but realistic slice of `leap-seconds.list`. The first entry is the
// offset in force at the start of coverage; the second entry inserts a leap
// second at NTP 2272060801 (the end of 1971-12-31).
const SAMPLE = [
  '# comment line that must be ignored',
  '#@ 3000000000',
  '2272060800 10 # 1 Jan 1972',
  '2287785600 11 # 1 Jul 1972',
  '2303683200 12 # 1 Jan 1973',
  '',
].join('\n');

test('parses entries and expiry comment', () => {
  const parsed = parseLeapSecondTable(SAMPLE);
  assert.equal(parsed.expires, 3000000000);
  assert.deepEqual(parsed.entries, [
    { ntpSeconds: 2272060800, taiMinusUtc: 10 },
    { ntpSeconds: 2287785600, taiMinusUtc: 11 },
    { ntpSeconds: 2303683200, taiMinusUtc: 12 },
  ]);
});

test('rejects a malformed data line', () => {
  assert.throws(
    () => parseLeapSecondTable('2272060800 ten'),
    (err) => err instanceof LeapSecondError && /not an integer/.test(err.message)
  );
});

test('rejects a table with no data lines', () => {
  assert.throws(
    () => parseLeapSecondTable('# only a comment'),
    (err) => err instanceof LeapSecondError && /no data lines/.test(err.message)
  );
});

test('rejects non-increasing NTP seconds', () => {
  const text = '2272060800 10\n2272060800 11';
  assert.throws(
    () => parseLeapSecondTable(text),
    (err) => err instanceof LeapSecondError && /not greater/.test(err.message)
  );
});

test('rejects a decreasing TAI-UTC offset', () => {
  const text = '2272060800 10\n2287785600 9';
  assert.throws(
    () => parseLeapSecondTable(text),
    (err) => err instanceof LeapSecondError && /decreased/.test(err.message)
  );
});

test('offsetAt returns the offset in force at and after an entry', () => {
  const table = new LeapSecondTable(parseLeapSecondTable(SAMPLE));
  assert.equal(table.offsetAt(2272060800), 10);
  assert.equal(table.offsetAt(2287785600), 11);
  // One second before the second entry the old offset still applies.
  assert.equal(table.offsetAt(2287785599), 10);
  // Before coverage begins we fall back to the first entry's value.
  assert.equal(table.offsetAt(0), 10);
  // Well after the last entry the last value applies.
  assert.equal(table.offsetAt(4000000000), 12);
});

test('isLeapSecond is true only for the second before an insertion', () => {
  const table = new LeapSecondTable(parseLeapSecondTable(SAMPLE));
  assert.equal(table.isLeapSecond(2287785599), true);
  assert.equal(table.isLeapSecond(2287785600), false);
  assert.equal(table.isLeapSecond(2287785598), false);
  // The first entry establishes the starting offset; it is not an insertion.
  assert.equal(table.isLeapSecond(2272060799), false);
  assert.equal(table.isLeapSecond(2303683199), true);
});

test('nextLeapSecondAfter is strictly after the query', () => {
  const table = new LeapSecondTable(parseLeapSecondTable(SAMPLE));
  assert.equal(table.nextLeapSecondAfter(0), 2287785599);
  assert.equal(table.nextLeapSecondAfter(2287785599), 2303683199);
  assert.equal(table.nextLeapSecondAfter(2303683199), null);
});

test('constructor rejects an empty entry list', () => {
  assert.throws(
    () => new LeapSecondTable({ entries: [] }),
    (err) => err instanceof LeapSecondError && /at least one entry/.test(err.message)
  );
});

test('constructor rejects non-integer fields', () => {
  assert.throws(
    () => new LeapSecondTable({ entries: [{ ntpSeconds: 1.5, taiMinusUtc: 10 }] }),
    (err) => err instanceof LeapSecondError && /integer fields/.test(err.message)
  );
});

test('constructor copies its input so later mutation cannot change answers', () => {
  const parsed = parseLeapSecondTable(SAMPLE);
  const table = new LeapSecondTable(parsed);
  parsed.entries[0].taiMinusUtc = 999;
  assert.equal(table.offsetAt(2272060800), 10);
});

test('unix and NTP conversions round-trip', () => {
  assert.equal(LeapSecondTable.unixToNtp(0), 2208988800);
  assert.equal(LeapSecondTable.ntpToUnix(2208988800), 0);
  const table = new LeapSecondTable(parseLeapSecondTable(SAMPLE));
  assert.equal(table.size, 3);
});

test('dateToNtp floors sub-second components', () => {
  const date = new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 999));
  assert.equal(LeapSecondTable.dateToNtp(date), 2208988800);
});

test('dateToNtp rejects an invalid Date', () => {
  assert.throws(
    () => LeapSecondTable.dateToNtp(new Date('not a date')),
    (err) => err instanceof LeapSecondError && /valid Date/.test(err.message)
  );
});

test('parseNtpEraFile accepts a well-formed header', () => {
  const text = [
    '#$ 1900-01-01 00:00:00 UTC',
    '2272060800 10',
    '2287785600 11',
  ].join('\n');
  const parsed = parseNtpEraFile(text);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[1].taiMinusUtc, 11);
});

test('parseNtpEraFile rejects a missing header', () => {
  assert.throws(
    () => parseNtpEraFile('2272060800 10'),
    (err) => err instanceof LeapSecondError && /must start with/.test(err.message)
  );
});

test('query methods reject non-integer input', () => {
  const table = new LeapSecondTable(parseLeapSecondTable(SAMPLE));
  assert.throws(
    () => table.offsetAt(1.5),
    (err) => err instanceof LeapSecondError && /must be an integer/.test(err.message)
  );
  assert.throws(
    () => table.isLeapSecond('2287785599'),
    (err) => err instanceof LeapSecondError && /must be an integer/.test(err.message)
  );
});
