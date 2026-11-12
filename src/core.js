// Core parsing and query logic for IETF leap-second tables.
//
// The IETF publishes leap-second data in two shapes that we care about:
//
//   * the `leap-seconds.list` file, a whitespace-separated table where each
//     line is `<NTP seconds> <TAI-UTC offset> # comment`; and
//   * the older NTP era file format used by `ntp` distributions, which starts
//     with a `#$` header line giving the NTP epoch as an absolute date.
//
// Both formats ultimately describe the same thing: a list of instants at which
// the TAI-UTC offset changed. A leap second is *inserted* when the offset
// increases by one second. The instant of insertion is the last second of the
// UTC day, and the offset change takes effect at the following midnight.
//
// We model time purely as integer NTP seconds (seconds since 1900-01-01).
// Floating point would be wrong here: leap seconds are integer events and the
// whole point of the table is to be exact. Callers who have a UTC timestamp
// in another representation are expected to convert to NTP seconds first;
// `LeapSecondTable` exposes helpers for the two most common conversions
// (Unix epoch seconds and a `Date`).

/**
 * Error thrown for malformed or inconsistent leap-second data.
 */
export class LeapSecondError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeapSecondError';
  }
}

// Seconds between the NTP epoch (1900-01-01T00:00:00Z) and the Unix epoch
// (1970-01-01T00:00:00Z). This is a constant of the calendar, not of the
// table, so it lives here rather than being parsed.
const NTP_UNIX_EPOCH_DIFF = 2208988800;

/**
 * Parse an IETF `leap-seconds.list` document.
 *
 * The accepted grammar is intentionally narrow: a sequence of lines, each of
 * which is either blank, a comment (first non-space character is `#`), or a
 * data line of the form
 *
 *     <ntp-seconds> <tai-minus-utc> [# comment]
 *
 * We do not attempt to be liberal. A malformed data line is an error rather
 * than something to skip, because silently dropping a leap second would make
 * every subsequent query wrong.
 *
 * @param {string} text raw file contents
 * @returns {{expires: number|null, entries: Array<{ntpSeconds: number, taiMinusUtc: number}>}}
 * @throws {LeapSecondError} if a data line cannot be parsed or the entries are
 *   not strictly increasing in both fields
 */
export function parseLeapSecondTable(text) {
  if (typeof text !== 'string') {
    throw new LeapSecondError('leap-second table must be a string');
  }

  const entries = [];
  let expires = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    // Comment lines carry metadata. The only field we understand is the
    // expiration (`#@`), which is advisory: it tells readers when a newer
    // file should be fetched. We surface it but never enforce it.
    if (trimmed.startsWith('#')) {
      const expiry = parseExpiryComment(trimmed);
      if (expiry !== null) expires = expiry;
      continue;
    }

    // Strip an inline comment before splitting fields.
    const hashIndex = raw.indexOf('#');
    const dataPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
    const fields = dataPart.trim().split(/\s+/);
    if (fields.length < 2) {
      throw new LeapSecondError(
        `line ${i + 1}: expected at least two fields, got ${fields.length}`
      );
    }

    const ntpSeconds = parseInteger(fields[0], i + 1, 'NTP seconds');
    const taiMinusUtc = parseInteger(fields[1], i + 1, 'TAI-UTC offset');
    entries.push({ ntpSeconds, taiMinusUtc });
  }

  if (entries.length === 0) {
    throw new LeapSecondError('leap-second table contains no data lines');
  }

  // Validate monotonicity. The IETF file is ordered by construction, but a
  // truncated or hand-edited file is exactly the failure mode a loader should
  // catch rather than paper over.
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.ntpSeconds <= prev.ntpSeconds) {
      throw new LeapSecondError(
        `entry ${i}: NTP seconds ${cur.ntpSeconds} not greater than previous ${prev.ntpSeconds}`
      );
    }
    if (cur.taiMinusUtc < prev.taiMinusUtc) {
      throw new LeapSecondError(
        `entry ${i}: TAI-UTC offset decreased from ${prev.taiMinusUtc} to ${cur.taiMinusUtc}`
      );
    }
  }

  return { expires, entries };
}

/**
 * Parse the NTP era file format used by `ntp` distributions.
 *
 * This format prefixes the table with a `#$` line that encodes the NTP epoch
 * as an absolute date. We parse it because the offset arithmetic is the same
 * once the epoch is known, and rejecting the file outright would force callers
 * to pre-process it themselves.
 *
 * The returned shape matches {@link parseLeapSecondTable} so the two parsers
 * are interchangeable.
 *
 * @param {string} text raw file contents
 * @returns {{expires: number|null, entries: Array<{ntpSeconds: number, taiMinusUtc: number}>}}
 * @throws {LeapSecondError} on malformed input
 */
export function parseNtpEraFile(text) {
  if (typeof text !== 'string') {
    throw new LeapSecondError('leap-second table must be a string');
  }

  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].startsWith('#$')) {
    throw new LeapSecondError('NTP era file must start with a #$ header line');
  }

  // The header is `#$ <date> <time> <zone>`; we only need the date to confirm
  // the file is well-formed. The actual epoch is always the NTP epoch, so we
  // do not derive anything from it beyond validation.
  const headerFields = lines[0].slice(2).trim().split(/\s+/);
  if (headerFields.length < 2) {
    throw new LeapSecondError('malformed #$ header: expected a date and a time');
  }

  // Reuse the main parser on the remainder. It will reject `#$` lines, but we
  // have already consumed the only one we expect.
  return parseLeapSecondTable(lines.slice(1).join('\n'));
}

/**
 * A parsed leap-second table with query methods.
 *
 * The class is immutable after construction. All query methods are pure and
 * take an explicit NTP-seconds argument, so there is no hidden dependence on
 * the wall clock and tests are deterministic.
 */
export class LeapSecondTable {
  /**
   * @param {{expires?: number|null, entries: Array<{ntpSeconds: number, taiMinusUtc: number}>}} data
   *   output of {@link parseLeapSecondTable} or {@link parseNtpEraFile}
   * @throws {LeapSecondError} if the entries are empty or not monotonic
   */
  constructor(data) {
    if (data === null || typeof data !== 'object') {
      throw new LeapSecondError('LeapSecondTable requires a parsed table object');
    }
    const entries = data.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new LeapSecondError('LeapSecondTable requires at least one entry');
    }

    // Copy defensively so a caller mutating their input array cannot change
    // our answers after construction.
    const copy = entries.map((entry, index) => {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        !Number.isInteger(entry.ntpSeconds) ||
        !Number.isInteger(entry.taiMinusUtc)
      ) {
        throw new LeapSecondError(`entry ${index}: expected integer fields`);
      }
      return { ntpSeconds: entry.ntpSeconds, taiMinusUtc: entry.taiMinusUtc };
    });

    for (let i = 1; i < copy.length; i++) {
      if (copy[i].ntpSeconds <= copy[i - 1].ntpSeconds) {
        throw new LeapSecondError('entries must be strictly increasing in NTP seconds');
      }
      if (copy[i].taiMinusUtc < copy[i - 1].taiMinusUtc) {
        throw new LeapSecondError('TAI-UTC offset must not decrease');
      }
    }

    this._entries = copy;
    this._expires = data.expires === undefined ? null : data.expires;
  }

  /**
   * The advisory expiration instant from the `#@` comment, in NTP seconds, or
   * `null` if the source file did not carry one.
   * @returns {number|null}
   */
  get expires() {
    return this._expires;
  }

  /**
   * Number of entries in the table.
   * @returns {number}
   */
  get size() {
    return this._entries.length;
  }

  /**
   * The TAI-UTC offset in effect at the given NTP instant.
   *
   * The offset in effect at an entry's `ntpSeconds` is that entry's value:
   * the change takes effect at the start of the second named by the entry.
   * Before the first entry the offset is the first entry's value, which is the
   * conventional reading of a leap-second table (the first entry records the
   * offset already in force at the start of the table's coverage).
   *
   * @param {number} ntpSeconds integer NTP seconds
   * @returns {number} TAI-UTC offset in whole seconds
   */
  offsetAt(ntpSeconds) {
    assertInteger(ntpSeconds, 'ntpSeconds');
    const entries = this._entries;
    // Binary search for the last entry whose ntpSeconds is <= the query.
    let lo = 0;
    let hi = entries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].ntpSeconds <= ntpSeconds) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) return entries[0].taiMinusUtc;
    return entries[found].taiMinusUtc;
  }

  /**
   * Whether the given UTC instant is a leap second.
   *
   * A leap second is inserted at the end of a UTC day, so it occupies the
   * single second immediately before the entry's `ntpSeconds`. That is: the
   * leap second for an entry at N runs over `[N - 1, N)`. We report `true`
   * exactly for integer instants in that interval.
   *
   * Negative leap seconds (offset decreasing) are not produced by the IETF
   * tables and are rejected at construction, so every increase of one second
   * corresponds to an inserted leap second.
   *
   * @param {number} ntpSeconds integer NTP seconds
   * @returns {boolean}
   */
  isLeapSecond(ntpSeconds) {
    assertInteger(ntpSeconds, 'ntpSeconds');
    const entries = this._entries;
    // Walk every entry that could have inserted a leap second just before it.
    // The table is small (tens of entries) and this keeps the logic obvious.
    for (let i = 1; i < entries.length; i++) {
      const delta = entries[i].taiMinusUtc - entries[i - 1].taiMinusUtc;
      if (delta === 1 && ntpSeconds === entries[i].ntpSeconds - 1) {
        return true;
      }
    }
    return false;
  }

  /**
   * The NTP instant at which the next leap second is inserted strictly after
   * `ntpSeconds`, or `null` if the table does not contain one.
   *
   * "Strictly after" means a query exactly on an insertion instant returns the
   * following one, which is what a scheduler wants when it asks "when is the
   * next one?".
   *
   * @param {number} ntpSeconds integer NTP seconds
   * @returns {number|null}
   */
  nextLeapSecondAfter(ntpSeconds) {
    assertInteger(ntpSeconds, 'ntpSeconds');
    const entries = this._entries;
    for (let i = 1; i < entries.length; i++) {
      const delta = entries[i].taiMinusUtc - entries[i - 1].taiMinusUtc;
      if (delta === 1 && entries[i].ntpSeconds - 1 > ntpSeconds) {
        return entries[i].ntpSeconds - 1;
      }
    }
    return null;
  }

  /**
   * Convert Unix epoch seconds to NTP seconds.
   * @param {number} unixSeconds integer seconds since 1970-01-01T00:00:00Z
   * @returns {number}
   */
  static unixToNtp(unixSeconds) {
    assertInteger(unixSeconds, 'unixSeconds');
    return unixSeconds + NTP_UNIX_EPOCH_DIFF;
  }

  /**
   * Convert NTP seconds to Unix epoch seconds.
   * @param {number} ntpSeconds integer seconds since 1900-01-01T00:00:00Z
   * @returns {number}
   */
  static ntpToUnix(ntpSeconds) {
    assertInteger(ntpSeconds, 'ntpSeconds');
    return ntpSeconds - NTP_UNIX_EPOCH_DIFF;
  }

  /**
   * Convert a `Date` to NTP seconds, truncating sub-second components.
   *
   * Leap seconds are integer events, so a `Date` with milliseconds is floored
   * to the enclosing second. We floor rather than round because rounding a
   * timestamp near a leap-second boundary could move the query to the wrong
   * side of the boundary.
   *
   * @param {Date} date
   * @returns {number}
   */
  static dateToNtp(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new LeapSecondError('dateToNtp requires a valid Date');
    }
    const unixSeconds = Math.floor(date.getTime() / 1000);
    return LeapSecondTable.unixToNtp(unixSeconds);
  }
}

function parseInteger(field, lineNumber, label) {
  if (!/^-?\d+$/.test(field)) {
    throw new LeapSecondError(`line ${lineNumber}: ${label} is not an integer: ${field}`);
  }
  const value = Number(field);
  if (!Number.isSafeInteger(value)) {
    throw new LeapSecondError(`line ${lineNumber}: ${label} out of safe integer range: ${field}`);
  }
  return value;
}

function parseExpiryComment(line) {
  // The `#@` comment is `<seconds> <comment>`. Anything else is ignored; a
  // malformed expiry should not make the whole file unreadable.
  const match = /^#@\s+(\d+)/.exec(line);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new LeapSecondError(`${name} must be an integer, got ${String(value)}`);
  }
}
