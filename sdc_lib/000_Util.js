/**
 * @file 000_Util.gs
 * Small, pure (or near-pure) primitives used across the library and
 * available to consumers. Nothing here knows about the SDC domain;
 * if it does, it belongs in a domain namespace.
 *
 * Public:
 *   Util.coerceTruthy(value)                 → boolean
 *   Util.isValidEmailShape(email)            → boolean
 *   Util.newCorrelationId()                  → string
 *   Util.findValueRightOfLabel(sheet, lbl)   → * | null
 *   Util.getActiveUserEmail(fallback)        → string
 */

var Util = {};

var TRUTHY_VALUES = Object.freeze(new Set(['true', '1', 'yes']));

/**
 * Coerce a cell value to boolean. Recognizes native true, and the strings
 * "true" / "1" / "yes" (case-insensitive, trimmed). Everything else → false.
 */
Util.coerceTruthy = function(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;
  return TRUTHY_VALUES.has(String(value).trim().toLowerCase());
};
/**
 * Lightweight email shape validator. Catches blanks, missing @, missing TLD.
 * Not a full RFC 5322 validator — that's a different problem.
 */
Util.isValidEmailShape = function(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};
/**
 * Generate a new correlation ID for tracing a request across the SDC stack.
 * Currently a UUID; centralized here so future changes (prefixes, traceparent
 * compatibility, alternate ID schemes) are a single-function update.
 */
Util.newCorrelationId = function() {
  return Utilities.getUuid();
};
/**
 * Read the active user's email with defensive try/catch and fallback.
 *
 * Session.getActiveUser().getEmail() can throw in some trigger contexts (where the user identity isn't available) 
 * and can return empty string when scopes aren't granted. Both cases collapse to the fallback here.
 *
 * Three call sites in v1.0: Log.append, Validate.run, Portal.run.
 *
 * @param {string} [fallback='unknown'] - Returned on missing identity.
 * @returns {string}
 */
Util.getActiveUserEmail = function(fallback) {
  fallback = fallback === undefined ? 'unknown' : fallback;
  try {
    return Session.getActiveUser().getEmail() || fallback;
  } catch (e) {
    return fallback;
  }
};
/**
 * SHA-256 of a UTF-8 string, lowercase hex. Pure; used to fingerprint serialized config. Apps Script
 * returns SIGNED bytes (-128..127), hence the & OxFF mask before hex-encoding.
 */
Util.sha256Hex = function(input) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(input), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
  }
  return hex;
};
/** Normalize a date-ish cell value to "yyyy-mm-dd", or null if unrecognizable. */
Util.toIsoDate = function(value, tz) {
  // NOT `value instanceof Date`: instanceof is context-sensitive across the GAS library boundary. A Date 
  // minted from a container-created Spreadsheet fails `instanceof Date` inside the library (separate globals, separate
  // Date constructors). Object.prototype.toString is the cross-context-safe brand check.
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  var s = String(value === null || value === undefined ? '' : value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
/**
 * Locate the CELL containing a label string. 1-based row/col, matching Range coordinates. Case-insensitive 
 * after trim, first match wins (top-to-bottom, left-to-right) — same match semantics as the old findValueRightOfLabel,
 * factored out so callers that need the position (named-range creation, migration rewrites) share one implementation
 * with callers that need the value.
 *
 * @param {Sheet}  sheet
 * @param {string} label
 * @returns {{row: number, col: number} | null}
 */
Util.findLabelCell = function(sheet, label) {
  if (!sheet || !label) return null;

  var data   = sheet.getDataRange().getValues();
  var target = String(label).toLowerCase().trim();

  for (var i = 0; i < data.length; i++) {
    for (var j = 0; j < data[i].length; j++) {
      if (String(data[i][j]).toLowerCase().trim() === target) {
        return { row: i + 1, col: j + 1 };
      }
    }
  }
  return null;
};

/**
 * Search a sheet for a label string and return the first non-empty value
 * in the up-to-three columns to its right.
 *
 * As of schema 1.4 this is the FALLBACK read path (and the migration's historical-value reader) — 
 * the primary path is named ranges via Customer.read. Behavior is unchanged from 1.3; it now delegates label
 * location to Util.findLabelCell.
 *
 * Treats 0 and false as valid values — only null, undefined, and '' are blank.
 */
Util.findValueRightOfLabel = function(sheet, label) {
  var cell = Util.findLabelCell(sheet, label);
  if (!cell) return null;

  var lastCol   = sheet.getLastColumn();
  var maxOffset = Math.min(3, lastCol - cell.col);
  if (maxOffset < 1) return null;

  var notBlank = function(v) { return v !== null && v !== undefined && v !== ''; };
  var vals = sheet.getRange(cell.row, cell.col + 1, 1, maxOffset).getValues()[0];

  for (var k = 0; k < vals.length; k++) {
    if (notBlank(vals[k])) return vals[k];
  }
  return null;
};