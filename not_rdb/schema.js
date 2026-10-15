/**
 * @file Schema.gs — the Salesforce field schema: fetched from the Workato `/fetch-schema` endpoint, cached in a
 * `_schema` tab, and loaded per run as a map keyed by wire key.
 *
 * @summary Three public-ish entry points and a handful of pure helpers. refreshSchema() calls the endpoint and
 * rewrites `_schema` wholesale. loadSchema_() reads the tab into memory once per run. schemaFor_() looks a field
 * up by its Config label. Everything between them is pure so it can be tested without a sheet or a network.
 *
 * @description Design notes:
 *   1. The join key is toSnake_(salesforce_label), the same function that turns an output_fields label into a wire
 *      key in buildPayload_. If the Config label matches the Salesforce label, the field self-joins; nothing in this
 *      project maps one name to another. Labels that do not join are REPORTED (rows 2-3 of the tab, and a WARN log
 *      line) rather than guessed, so a renamed Salesforce field shows up as a warning, never as a silent regression.
 *   2. The tab is the cache, not CacheService: it is inspectable, it survives longer than six hours, and it matches
 *      the `_models` convention the team already knows. It is machine-owned (underscore prefix) and positional,
 *      like `_queue`.
 *   3. OVERWRITE, never update. A refresh clears and rewrites; if the endpoint fails, nothing is written and the
 *      previous schema stands. loadSchema_() returns {} when the tab is missing or empty, and every consumer treats
 *      {} as "no knowledge" — prompt hints are skipped, the push gate passes values through unchanged — so a missing
 *      schema can never make a push fail that would succeed today.
 *   4. Picklist values live in one JSON cell per field. Sheets caps a cell at 50,000 characters; the largest list
 *      (countries, ~250 values) is well under that, and schemaRows_() throws a clear error naming the field if one
 *      ever is not, rather than truncating.
 *   5. The endpoint caches on correlation_id. A fresh UUID per refresh deliberately bypasses that cache; it exists to
 *      absorb retries, not to serve stale schemas.
 *
 * LAYOUT (`_schema`)
 *   A1  Fetched at                        B1  <ISO timestamp>
 *   A2  Config labels not in Salesforce   B2  comma list (empty = all join)
 *   A3  Salesforce fields not in Config   B3  comma list (informational)
 *   A4  (blank)
 *   A5  Key | Name | Label | Type | Length | Scale | Precision | Controller | Values
 *   A6+ one row per createable field; Values is JSON [{value,label,valid_for[]}] or blank
 *
 * WIRING (two one-liners elsewhere)
 *   ConfigTools.gs onOpen():  .addItem('Refresh field schema', 'refreshSchema')
 *   ContractIntake.gs setupTriggers():  setupSchemaTrigger();
 *
 * DEPLOY: clasp push. Add Config key workato_schema_url (locked; the endpoint's full URL without the query string).
 */

/** @const {string} Tab holding the cached field schema, inside the config spreadsheet. */
const SCHEMA_SHEET_NAME = '_schema';
/** @const {number} Row of the field table header; data starts on the next row. */
const SCHEMA_HEADER_ROW = 5;
/** @const {string[]} Field table header. Column order is the contract with schemaFromRows_(). */
const SCHEMA_HEADERS = ['Key', 'Name', 'Label', 'Type', 'Length', 'Scale', 'Precision', 'Controller', 'Values'];
/**
 * Metadata labels and the fixed row each lives on.
 * @const {Object.<string,{label:string,row:number}>}
 */
const SCHEMA_META = {
  FETCHED: { label: 'Fetched at', row: 1 },
  UNMATCHED_CONFIG: { label: 'Config labels not in Salesforce', row: 2 },
  UNMATCHED_SF: { label: 'Salesforce fields not in Config', row: 3 }
};
/** @const {number} Largest Values cell we will write. Sheets' hard limit is 50,000 characters. */
const SCHEMA_VALUES_MAX_CHARS = 49000;
/** @const {string[]} Field types that carry a values list. */
const SCHEMA_PICKLIST_TYPES = ['picklist', 'multipicklist'];
/** @const {number} Hour (script time zone) at which the daily refresh runs. */
const SCHEMA_REFRESH_HOUR = 6;

/**
 * One cached field, as loadSchema_() returns it.
 * @typedef {Object} SchemaField
 * @property {string}  key        toSnake_(label); the wire key this field joins on.
 * @property {string}  name       Salesforce API name, e.g. 'Type_of_Contract__c'.
 * @property {string}  label      Salesforce field label.
 * @property {string}  type       Salesforce type: picklist | multipicklist | boolean | date | datetime | double |
 *                                percent | currency | int | string | textarea | url | reference | ...
 * @property {number}  length     Max characters for text types; 0 otherwise.
 * @property {number}  scale      Decimal places for numeric types.
 * @property {number}  precision  Total digits for numeric types.
 * @property {?string} controller API name of the controlling field for dependent picklists; null otherwise.
 * @property {?Array<{value:string,label:string,valid_for:string[]}>} values Active picklist values; null for
 *                                non-picklist types. valid_for lists the controller VALUES for which the value is
 *                                allowed; empty for independent picklists.
 */

/**
 * The cached schema: wire key -> field.
 * @typedef {Object.<string,SchemaField>} Schema
 */


// --- REFRESH (menu / trigger) ---------------------------------------------------------------
/**
 * Fetch the field schema from Workato and rewrite the `_schema` tab. Safe to run any time; on any failure nothing is
 * written and the previous tab stands. Logs a summary, warns about labels that do not join, and shows a one-line
 * result when a UI exists.
 * @return {number} Fields written.
 */
function refreshSchema() {
  const cfg = readConfig_();
  const corr = Utilities.getUuid();
  const fields = fetchSchema_(cfg, corr);

  const built = schemaRows_(fields);                       // {rows, collisions}
  const keys = built.rows.map(function (r) { return r[0]; });
  const rec = reconcileSchema_(keys, cfg.output_fields);   // {unmatchedConfig, unmatchedSf}

  writeSchemaTab_(built.rows, rec);

  let summary = built.rows.length + ' fields written to ' + SCHEMA_SHEET_NAME + '.';
  if (rec.unmatchedConfig.length) {
    summary += ' ' + rec.unmatchedConfig.length + ' Config label(s) have no Salesforce field: ' + rec.unmatchedConfig.join(', ') + '.';
    logWarn_('refreshSchema', 'Config labels not in Salesforce', corr, rec.unmatchedConfig.join(', '));
  }
  if (built.collisions.length) {
    logWarn_('refreshSchema', 'Salesforce labels collide on wire key (first kept)', corr, built.collisions.join(', '));
  }
  logInfo_('refreshSchema', summary, corr);
  try { SpreadsheetApp.getUi().alert('Contract Intake', summary, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* no UI */ }
  return built.rows.length;
}

/**
 * Install (or reinstall) the daily refresh trigger. Idempotent: prior copies are removed first. Called from
 * setupTriggers(); also safe to run on its own.
 * @return {void}
 */
function setupSchemaTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshSchema') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshSchema').timeBased().everyDays(1).atHour(SCHEMA_REFRESH_HOUR).create();
}


// --- FETCH ----------------------------------------------------------------------------------
/**
 * GET the schema endpoint with the Workato auth token and delegate interpretation to the pure
 * {@link interpretSchemaResponse_}.
 * @param {Config} cfg
 * @param {string} corr Correlation id for this refresh (also the endpoint's cache key).
 * @return {Object[]} The endpoint's `fields` array, untouched.
 * @throws {Error} If workato_schema_url is unset, or the response is not a usable schema.
 * @private
 */
function fetchSchema_(cfg, corr) {
  if (!cfg.workato_schema_url) throw new Error('Config missing "workato_schema_url".');
  const url = cfg.workato_schema_url +
    (cfg.workato_schema_url.indexOf('?') === -1 ? '?' : '&') +
    'correlation_id=' + encodeURIComponent(corr);
  const headers = { 'X-Correlation-Id': corr };
  headers[WORKATO_TOKEN_HEADER] = workatoSecret_();

  const resp = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true });
  let json;
  try { json = JSON.parse(resp.getContentText()); }
  catch (e) { throw new Error('Schema endpoint ' + resp.getResponseCode() + ': response is not JSON.'); }
  return interpretSchemaResponse_(resp.getResponseCode(), json);
}

/**
 * Pure interpretation of the endpoint response. Throws on anything that is not a non-empty field list, so a failed
 * refresh can never overwrite the tab with nothing.
 * @param {number} code HTTP status.
 * @param {Object} json Parsed body.
 * @return {Object[]} `json.fields`.
 * @throws {Error} On non-200, ok:false, or a missing/empty fields array.
 * @private
 */
function interpretSchemaResponse_(code, json) {
  json = json || {};
  if (code !== 200) throw new Error('Schema endpoint ' + code + ': ' + (json.message || JSON.stringify(json)).slice(0, 300));
  if (json.ok === false) throw new Error('Schema endpoint: ' + (json.message || 'ok=false'));
  if (!Array.isArray(json.fields) || !json.fields.length) throw new Error('Schema endpoint returned no fields.');
  return json.fields;
}


// --- SHAPE (pure) ---------------------------------------------------------------------------
/**
 * Turn the endpoint's field objects into `_schema` rows in SCHEMA_HEADERS order. Pure.
 * Fields without a name or label are skipped. Two labels that snake to the same key keep the first and report the
 * collision. Non-picklist types get a blank Values cell.
 * @param {Object[]} fields As returned by the endpoint.
 * @return {{rows:Array<Array<*>>, collisions:string[]}}
 * @throws {Error} If a field's values JSON would exceed the cell limit.
 * @private
 */
function schemaRows_(fields) {
  const rows = [];
  const seen = {};
  const collisions = [];
  (fields || []).forEach(function (f) {
    const name = str_(f && f.name);
    const label = str_(f && f.label);
    if (!name || !label) return;
    const key = toSnake_(label);
    if (seen[key]) { collisions.push(key + ' (' + seen[key] + ', ' + name + ')'); return; }
    seen[key] = name;

    const type = str_(f.type).toLowerCase();
    let valuesJson = '';
    if (SCHEMA_PICKLIST_TYPES.indexOf(type) !== -1) {
      const values = (f.values || []).map(function (v) {
        return { value: str_(v.value), label: str_(v.label) || str_(v.value), valid_for: (v.valid_for || []).map(str_) };
      });
      valuesJson = JSON.stringify(values);
      if (valuesJson.length > SCHEMA_VALUES_MAX_CHARS) {
        throw new Error('Picklist "' + name + '" has ' + values.length + ' values (' + valuesJson.length +
          ' chars), over the cell limit; split the Values column before caching it.');
      }
    }
    rows.push([key, name, label, type, num_(f.length), num_(f.scale), num_(f.precision), str_(f.controller) || '', valuesJson]);
  });
  return { rows: rows, collisions: collisions };
}

/**
 * Compare schema keys with Config output_fields, both ways. Pure.
 * @param {string[]} schemaKeys Wire keys present in the schema.
 * @param {string[]} outputFields Config labels.
 * @return {{unmatchedConfig:string[], unmatchedSf:string[]}} Config labels with no field; field keys with no label.
 * @private
 */
function reconcileSchema_(schemaKeys, outputFields) {
  const have = {};
  (schemaKeys || []).forEach(function (k) { have[k] = true; });
  const want = {};
  const unmatchedConfig = [];
  (outputFields || []).forEach(function (label) {
    const k = toSnake_(label);
    want[k] = true;
    if (!have[k]) unmatchedConfig.push(label);
  });
  const unmatchedSf = (schemaKeys || []).filter(function (k) { return !want[k]; });
  return { unmatchedConfig: unmatchedConfig, unmatchedSf: unmatchedSf };
}

/**
 * Rebuild the in-memory schema from the tab's cell values. Pure. Locates the header row by its first cell so a
 * stray row above it cannot break the read. Rows with a blank key are skipped; a Values cell that fails to parse
 * is treated as "no values" rather than aborting the whole load.
 * @param {Array<Array<*>>} values The tab's getDataRange().getValues().
 * @return {Schema}
 * @private
 */
function schemaFromRows_(values) {
  const schema = {};
  let h = -1;
  for (let r = 0; r < (values || []).length; r++) {
    if (String(values[r][0]).trim() === SCHEMA_HEADERS[0] && String(values[r][1]).trim() === SCHEMA_HEADERS[1]) { h = r; break; }
  }
  if (h === -1) return schema;
  for (let r = h + 1; r < values.length; r++) {
    const row = values[r];
    const key = str_(row[0]);
    if (!key) continue;
    const type = str_(row[3]).toLowerCase();
    let parsed = null;
    if (SCHEMA_PICKLIST_TYPES.indexOf(type) !== -1) {
      try { parsed = JSON.parse(str_(row[8]) || '[]'); } catch (e) { parsed = []; }
    }
    schema[key] = {
      key: key,
      name: str_(row[1]),
      label: str_(row[2]),
      type: type,
      length: num_(row[4]),
      scale: num_(row[5]),
      precision: num_(row[6]),
      controller: str_(row[7]) || null,
      values: parsed
    };
  }
  return schema;
}

/**
 * Cell value -> number; anything unparseable -> 0.
 * @param {*} v
 * @return {number}
 * @private
 */
function num_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}


// --- TAB I/O --------------------------------------------------------------------------------
/**
 * Clear and rewrite the `_schema` tab: metadata block, header, rows. Creates the tab if missing.
 * @param {Array<Array<*>>} rows From schemaRows_().
 * @param {{unmatchedConfig:string[], unmatchedSf:string[]}} rec From reconcileSchema_().
 * @return {void}
 * @private
 */
function writeSchemaTab_(rows, rec) {
  const ss = getConfigSpreadsheet_();
  let sheet = ss.getSheetByName(SCHEMA_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SCHEMA_SHEET_NAME);
  sheet.clearContents();

  Object.keys(SCHEMA_META).forEach(function (k) {
    sheet.getRange(SCHEMA_META[k].row, 1).setValue(SCHEMA_META[k].label).setFontWeight('bold');
  });
  sheet.getRange(SCHEMA_META.FETCHED.row, 2).setValue(new Date().toISOString());
  sheet.getRange(SCHEMA_META.UNMATCHED_CONFIG.row, 2).setValue(rec.unmatchedConfig.join(', '));
  sheet.getRange(SCHEMA_META.UNMATCHED_SF.row, 2).setValue(rec.unmatchedSf.join(', '));

  sheet.getRange(SCHEMA_HEADER_ROW, 1, 1, SCHEMA_HEADERS.length).setValues([SCHEMA_HEADERS]).setFontWeight('bold');
  if (rows.length) sheet.getRange(SCHEMA_HEADER_ROW + 1, 1, rows.length, SCHEMA_HEADERS.length).setValues(rows);
  sheet.setFrozenRows(SCHEMA_HEADER_ROW);
  sheet.autoResizeColumns(1, SCHEMA_HEADERS.length - 1);   // leave Values at default width; it is JSON
  SpreadsheetApp.flush();
}

/**
 * Load the cached schema once per run. {} when the tab is missing or holds no rows; callers treat {} as
 * "no knowledge" and change nothing.
 * @return {Schema}
 * @private
 */
function loadSchema_() {
  const sheet = getConfigSpreadsheet_().getSheetByName(SCHEMA_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= SCHEMA_HEADER_ROW) return {};
  return schemaFromRows_(sheet.getDataRange().getValues());
}

/**
 * When the schema was last refreshed, or null if never.
 * @return {?Date}
 * @private
 */
function schemaFetchedAt_() {
  const sheet = getConfigSpreadsheet_().getSheetByName(SCHEMA_SHEET_NAME);
  if (!sheet) return null;
  const v = sheet.getRange(SCHEMA_META.FETCHED.row, 2).getValue();
  const d = v instanceof Date ? v : new Date(str_(v));
  return isNaN(d.getTime()) ? null : d;
}


// --- LOOKUP (pure) --------------------------------------------------------------------------
/**
 * The schema entry for a Config label, or null if it does not join.
 * @param {Schema} schema
 * @param {string} label A Config output_fields label.
 * @return {?SchemaField}
 * @private
 */
function schemaFor_(schema, label) {
  return (schema && schema[toSnake_(label)]) || null;
}

/**
 * Whether a schema entry is a (multi)picklist with values to match against.
 * @param {?SchemaField} field
 * @return {boolean}
 * @private
 */
function isPicklist_(field) {
  return !!(field && SCHEMA_PICKLIST_TYPES.indexOf(field.type) !== -1 && field.values && field.values.length);
}
