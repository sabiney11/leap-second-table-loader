# leap-second-table-loader

Parse IETF `leap-seconds.list` files (and the NTP era variant) into an
immutable table that answers whether a given UTC instant is a leap second.

```js
import {
  parseLeapSecondTable,
  LeapSecondTable,
} from 'leap-second-table-loader';

const text = [
  '#@ 3000000000',
  '2272060800 10 # 1 Jan 1972',
  '2287785600 11 # 1 Jul 1972',
  '2303683200 12 # 1 Jan 1973',
].join('\n');

const table = new LeapSecondTable(parseLeapSecondTable(text));

table.offsetAt(2287785600);        // 11

table.isLeapSecond(2287785599);    // true  (the second before the 1972-07-01 insertion)
table.isLeapSecond(2287785600);    // false

table.nextLeapSecondAfter(0);      // 2287785599
table.nextLeapSecondAfter(2303683199); // null

LeapSecondTable.unixToNtp(0);      // 2208988800
LeapSecondTable.ntpToUnix(2208988800); // 0
LeapSecondTable.dateToNtp(new Date(Date.UTC(1970, 0, 1))); // 2208988800
```

## Why this exists

Leap-second tables are small, but the boundary arithmetic around them is easy
to get subtly wrong: the inserted second is the one *before* the entry, not the
entry itself, and a timestamp one second on either side of an entry means the
difference between the old and new TAI-UTC offset. This library keeps that
arithmetic in one place and works entirely in integer NTP seconds, because
leap seconds are integer events and doing the comparison in floating point
would reintroduce exactly the boundary errors the library is meant to avoid.

The trade-off is that the table is loaded in full and held in memory. That is
fine for the IETF files (a few dozen lines) and avoids any dependency on
external storage or a network fetch. The library never fetches anything; you
hand it the file contents and it hands you a queryable table.

## The awkward edge

A leap second has no representation in POSIX time, so if you start from a
`Date` or a Unix timestamp you are already outside the library's model. The
conversions here (`unixToNtp`, `ntpToUnix`, `dateToNtp`) treat the input as an
unambiguous count of seconds and do not attempt to smear or otherwise
reconcile a Unix clock that is running through a leap second. `dateToNtp`
floors sub-second components; it does not round, because rounding near a
boundary could move the query to the wrong side of the insertion.

## API

- `parseLeapSecondTable(text)` returns `{ expires, entries }`, where `entries`
is an array of `{ ntpSeconds, taiMinusUtc }` and `expires` is the NTP second
from the `#@` comment or `null`.
- `parseNtpEraFile(text)` parses the NTP-era header (`#$ ...`) and otherwise
returns the same shape.
- `new LeapSecondTable(parsed)` builds the query object. It copies its input
and rejects empty or non-monotonic tables.
- `table.offsetAt(ntpSeconds)`, `table.isLeapSecond(ntpSeconds)`,
`table.nextLeapSecondAfter(ntpSeconds)`, `table.size`, `table.expires`.
- `LeapSecondTable.unixToNtp(seconds)`, `LeapSecondTable.ntpToUnix(seconds)`,
`LeapSecondTable.dateToNtp(date)`.
- `LeapSecondError` is thrown for malformed input and non-integer queries.

All query methods take integer NTP seconds and throw `LeapSecondError` for
anything else. Before the first entry the offset of the first entry is used;
after the last entry the last offset is used.
