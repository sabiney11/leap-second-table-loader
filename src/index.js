// Public entry point for leap-second-table-loader.
//
// The library is deliberately split into two layers: `core.js` holds the
// parsing and query logic, while this module is the stable surface that
// consumers import. Keeping the re-exports here means the internal file can
// be reorganised without breaking callers.

export {
  LeapSecondTable,
  parseLeapSecondTable,
  parseNtpEraFile,
  LeapSecondError,
} from './core.js';
