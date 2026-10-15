/**
 * @file Gate.gs — the push gate. Turns the reviewer's Approved column into typed, Salesforce-valid values before a
 * payload leaves for Workato, or explains exactly which cells are wrong and why.
 *
 * @summary Two functions matter: normalizeValue_() types ONE cell from its schema entry (pure), and
 * validateApproval_() runs it over a whole review sheet, collecting every failure into one message (pure).
 * processApprovals() calls the latter before pushToWorkato_(); a failure throws, so the existing
 * markError_ -> `_queue` row -> Chat path fires with a field-named message and the sheet stays in pending.
 *
 * @description Design notes:
 *   1. The schema decides, not the code. Each cell is handled by the Salesforce `type` of the field it joins to
 *      (through wireKey_, so aliases work) — picklist, multipicklist, boolean, date, double, percent, textarea,
 *      reference... No field is named anywhere in this file.
 *   2. {} schema means "no knowledge": every cell passes through trimmed, exactly as before the gate existed. A
 *      missing `_schema` tab can therefore never make a push fail that succeeds today.
 *   3. Labels in, API values out. The reviewer sees and types labels ("Master Services Agreement"); the wire carries
 *      the picklist's API value ("MSA"). Matching is trimmed and case-insensitive against both.
 *   4. All failures at once. One push attempt reports every bad cell, in review-sheet order, so the reviewer fixes
 *      them in one pass (the ConfigEditor principle).
 *   5. Empty is allowed. A blank Approved cell becomes null and the recipe's `present? ? x : skip` guard leaves the
 *      Salesforce field alone. Required-ness is Salesforce's call, surfaced through the recipe's 400.
 *   6. Dates never shift. A Sheets date cell is a Date at local midnight; toISOString() would move it to the
 *      previous day for any zone east of UTC. Everything date-like is formatted in the script's own time zone, and
 *      an ISO 'yyyy-MM-dd' string is passed through untouched rather than re-parsed as UTC.
 *   7. Dependent picklists are checked in a second pass against the CONTROLLER's normalized value, so a corrected
 *      controller and a dependent are judged together. An empty valid_for list means "no restriction".
 *
 * WIRING
 *   processApprovals():  const schema = loadSchema_();  ...  const gate = validateApproval_(approval, cfg, schema);
 *                        if (!gate.ok) throw new Error(gate.message);  pushToWorkato_(approval, cfg, gate.fields);
 *   buildPayload_(approval, cfg, typedFields)  — uses typedFields when given, else approval.fields (tests, dry runs).
 */

/** @const {number} How many options an error message lists before truncating. */
const GATE_MAX_OPTIONS_SHOWN = 12;
/** @const {RegExp} Separator for multipicklist cells: semicolon or newline. Commas are NOT separators (labels contain them). */
const GATE_MULTI_SEP = /[;\n]+/;
/** @const {RegExp} An ISO calendar date, passed through as-is. */
const GATE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** @const {RegExp} First signed decimal number in a string ("90 days" -> 90, "1.5 %" -> 1.5, "$12,000" -> 12000 after comma strip). */
const GATE_NUMBER = /-?\d+(?:\.\d+)?/;
/** @const {Object.<string,boolean>} Cell spellings that mean true / false. */
const GATE_TRUE = { 'true': true, 'yes': true, 'y': true, '1': true, 'x': true, '✓': true, 'checked': true };
const GATE_FALSE = { 'false': true, 'no': true, 'n': true, '0': true, 'unchecked': true };

/**
 * Result of normalizing one cell.
 * @typedef {Object} GateResult
 * @property {boolean} ok
 * @property {*} value   Typed value for the wire (string | number | boolean | null). Meaningless when !ok.
 * @property {string} message  Why it failed; '' when ok.
 */

/**
 * Result of validating a whole review sheet.
 * @typedef {Object} GateReport
 * @property {boolean} ok
 * @property {Object.<string,*>} fields  Label -> typed value (same keys as approval.fields).
 * @property {string[]} errors  One line per bad cell, in review-sheet order.
 * @property {string} message  All errors joined, prefixed for the Last error cell; '' when ok.
 */


// --- WHOLE SHEET ----------------------------------------------------------------------------
/**
 * Normalize and validate every Approved value against the cached schema. Pure.
 * @param {Approval} approval From readApproval_(); `fields` is label -> raw cell value.
 * @param {Config} cfg Supplies field_keys for the label -> wire-key join.
 * @param {Schema} schema From loadSchema_(); {} passes everything through.
 * @return {GateReport}
 * @private
 */
function validateApproval_(approval, cfg, schema) {
  const labels = Object.keys(approval.fields || {});
  const out = {};
  const errors = [];
  const byName = {};                                        // Salesforce API name -> {label, field, value}

  // Pass 1: type every cell on its own.
  labels.forEach(function (label) {
    const field = schemaFor_(schema, cfg, label);
    const r = normalizeValue_(field, approval.fields[label]);
    out[label] = r.ok ? r.value : null;
    if (!r.ok) errors.push(label + ': ' + r.message);
    if (field) byName[field.name] = { label: label, field: field, value: out[label] };
  });

  // Pass 2: dependent picklists against the controller's normalized value.
  labels.forEach(function (label) {
    const field = schemaFor_(schema, cfg, label);
    if (!field || !field.controller || !isPicklist_(field) || out[label] == null) return;
    const ctrl = byName[field.controller];
    const msg = checkDependent_(field, out[label], ctrl ? ctrl.value : null, ctrl ? ctrl.label : field.controller);
    if (msg) { errors.push(label + ': ' + msg); out[label] = null; }
  });

  return {
    ok: errors.length === 0,
    fields: out,
    errors: errors,
    message: errors.length ? 'Not sent — fix the Approved column. ' + errors.join(' | ') : ''
  };
}

/**
 * Dependent-picklist check for one already-normalized value (single or ';'-joined). Pure.
 * @param {SchemaField} field The dependent field.
 * @param {string} value Normalized API value(s).
 * @param {?string} controllerValue The controller's normalized value, or null if blank/absent.
 * @param {string} controllerLabel For the message.
 * @return {string} '' when allowed; otherwise the reason.
 * @private
 */
function checkDependent_(field, value, controllerValue, controllerLabel) {
  const byValue = {};
  field.values.forEach(function (v) { byValue[v.value] = v; });
  const bad = String(value).split(';').filter(function (v) {
    const entry = byValue[v];
    const allowed = entry ? (entry.valid_for || []) : [];
    if (!allowed.length) return false;                      // unrestricted value
    return controllerValue == null || allowed.indexOf(String(controllerValue)) === -1;
  });
  if (!bad.length) return '';
  if (controllerValue == null) return '"' + bad.join('; ') + '" requires ' + controllerLabel + ' to be set first';
  return '"' + bad.join('; ') + '" is not valid when ' + controllerLabel + ' is "' + controllerValue + '"';
}


// --- ONE CELL -------------------------------------------------------------------------------
/**
 * Type one raw cell value by its schema entry. Pure. No field (label did not join) or no schema -> trimmed
 * pass-through, which is today's behaviour.
 * @param {?SchemaField} field From schemaFor_(); null when the label does not join.
 * @param {*} raw The Approved cell as getValues() returned it: string, number, boolean, Date, or ''.
 * @return {GateResult}
 * @private
 */
function normalizeValue_(field, raw) {
  if (isBlank_(raw)) return ok_(null);
  if (!field) return ok_(typeof raw === 'string' ? raw.trim() : raw);

  switch (field.type) {
    case 'picklist':      return normalizePick_(field, raw);
    case 'multipicklist': return normalizeMulti_(field, raw);
    case 'boolean':       return normalizeBool_(raw);
    case 'date':          return normalizeDate_(raw);
    case 'datetime':      return normalizeDateTime_(raw);
    case 'int':           return normalizeNumber_(raw, field, true);
    case 'double':
    case 'currency':      return normalizeNumber_(raw, field, false);
    case 'percent':       return normalizeNumber_(String(raw).replace(/%/g, ''), field, false);
    case 'url':           return normalizeUrl_(raw, field);
    case 'string':
    case 'textarea':
    case 'email':
    case 'phone':         return normalizeText_(raw, field);
    default:              return ok_(typeof raw === 'string' ? raw.trim() : raw);   // reference, id, anything new
  }
}

/** @private */ function ok_(value) { return { ok: true, value: value, message: '' }; }
/** @private */ function fail_(message) { return { ok: false, value: null, message: message }; }
/** @private */ function isBlank_(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
/** @private */ function fold_(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/**
 * Picklist: match raw against each value's API value or label, case-insensitively; emit the API value.
 * @param {SchemaField} field
 * @param {*} raw
 * @return {GateResult}
 * @private
 */
function normalizePick_(field, raw) {
  const hit = matchOption_(field, raw);
  if (hit) return ok_(hit.value);
  return fail_('"' + String(raw).trim() + '" is not an option; choose one of ' + optionList_(field));
}

/**
 * Multipicklist: split on ';' or newline, match each, de-duplicate, re-join with ';' as Salesforce expects.
 * @param {SchemaField} field
 * @param {*} raw
 * @return {GateResult}
 * @private
 */
function normalizeMulti_(field, raw) {
  const parts = String(raw).split(GATE_MULTI_SEP).map(function (s) { return s.trim(); }).filter(Boolean);
  const seen = {};
  const values = [];
  const bad = [];
  parts.forEach(function (p) {
    const hit = matchOption_(field, p);
    if (!hit) { bad.push(p); return; }
    if (!seen[hit.value]) { seen[hit.value] = true; values.push(hit.value); }
  });
  if (bad.length) {
    return fail_('"' + bad.join('; ') + '" ' + (bad.length === 1 ? 'is not an option' : 'are not options') +
      '; separate choices with ";" and choose from ' + optionList_(field));
  }
  return values.length ? ok_(values.join(';')) : ok_(null);
}

/**
 * Find the option whose API value or label equals raw (trimmed, case-insensitive).
 * @param {SchemaField} field
 * @param {*} raw
 * @return {?{value:string,label:string,valid_for:string[]}}
 * @private
 */
function matchOption_(field, raw) {
  const want = fold_(raw);
  if (!want) return null;
  const values = field.values || [];
  for (let i = 0; i < values.length; i++) {
    if (fold_(values[i].value) === want || fold_(values[i].label) === want) return values[i];
  }
  return null;
}

/**
 * "A | B | C" for messages, capped at GATE_MAX_OPTIONS_SHOWN with a count of the rest. Labels, since that is what
 * the reviewer types.
 * @param {SchemaField} field
 * @return {string}
 * @private
 */
function optionList_(field) {
  const labels = (field.values || []).map(function (v) { return v.label || v.value; });
  const shown = labels.slice(0, GATE_MAX_OPTIONS_SHOWN);
  const more = labels.length - shown.length;
  return shown.join(' | ') + (more > 0 ? ' | … ' + more + ' more' : '');
}

/**
 * Boolean: real booleans pass; common spellings map; anything else fails.
 * @param {*} raw
 * @return {GateResult}
 * @private
 */
function normalizeBool_(raw) {
  if (typeof raw === 'boolean') return ok_(raw);
  const s = fold_(raw);
  if (GATE_TRUE[s]) return ok_(true);
  if (GATE_FALSE[s]) return ok_(false);
  return fail_('"' + String(raw).trim() + '" must be yes or no');
}

/**
 * Date: a Date cell or a parseable string -> 'yyyy-MM-dd' in the script time zone. An ISO date string is passed
 * through unchanged (re-parsing it would read it as UTC midnight and shift the day).
 * @param {*} raw
 * @return {GateResult}
 * @private
 */
function normalizeDate_(raw) {
  if (typeof raw === 'string' && GATE_ISO_DATE.test(raw.trim())) return ok_(raw.trim());
  const d = toDate_(raw);
  if (!d) return fail_('"' + String(raw).trim() + '" is not a date; use YYYY-MM-DD');
  return ok_(Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
}

/**
 * Datetime: -> ISO 8601 in UTC.
 * @param {*} raw
 * @return {GateResult}
 * @private
 */
function normalizeDateTime_(raw) {
  const d = toDate_(raw);
  if (!d) return fail_('"' + String(raw).trim() + '" is not a date/time');
  return ok_(d.toISOString());
}

/**
 * Date cell or string -> Date, or null. Numeric slash dates are read the way the script's locale reads them (US).
 * @param {*} raw
 * @return {?Date}
 * @private
 */
function toDate_(raw) {
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== 'string') return null;
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Number: a number cell passes; a string yields its first signed decimal after stripping thousands separators and
 * currency symbols ("90 days" -> 90, "$12,000.50" -> 12000.5). Rounded to the field's scale; ints must be whole.
 * @param {*} raw
 * @param {SchemaField} field
 * @param {boolean} integer
 * @return {GateResult}
 * @private
 */
function normalizeNumber_(raw, field, integer) {
  let n;
  if (typeof raw === 'number') n = raw;
  else {
    const m = GATE_NUMBER.exec(String(raw).replace(/,/g, ''));
    if (!m) return fail_('"' + String(raw).trim() + '" is not a number');
    n = Number(m[0]);
  }
  if (!isFinite(n)) return fail_('"' + String(raw).trim() + '" is not a number');
  if (integer) {
    if (n !== Math.round(n)) return fail_('"' + String(raw).trim() + '" must be a whole number');
    return ok_(n);
  }
  const scale = Math.max(0, num_(field.scale));
  return ok_(Number(n.toFixed(scale)));
}

/**
 * Text: trim; enforce the field's length when it has one.
 * @param {*} raw
 * @param {SchemaField} field
 * @return {GateResult}
 * @private
 */
function normalizeText_(raw, field) {
  const s = String(raw).trim();
  const max = num_(field.length);
  if (max > 0 && s.length > max) return fail_(s.length + ' characters; Salesforce allows ' + max);
  return ok_(s);
}

/**
 * URL: trimmed, must start with http(s)://, then the text rules.
 * @param {*} raw
 * @param {SchemaField} field
 * @return {GateResult}
 * @private
 */
function normalizeUrl_(raw, field) {
  const s = String(raw).trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return fail_('"' + s + '" must be a full link starting with http:// or https://');
  return normalizeText_(s, field);
}
