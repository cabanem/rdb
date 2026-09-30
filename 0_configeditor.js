/**
 * @file ConfigEditor.gs — the Settings drawer on the dashboard: read Config for display, validate a draft, save it.
 *
 * @summary Three endpoints the page calls via google.script.run — getConfigForEdit(), validateConfigDraft(draft),
 * saveConfig(draft, revision) — and one schema, CONFIG_SCHEMA, that both ends read. The form is generated from the
 * schema in the browser; validation and the write are driven by it here. Adding a key to the editor is one entry in
 * the schema (and, if the pipeline is to use it, one line in parseConfig_).
 *
 * @description Design notes:
 *   1. The Config SHEET stays the source of truth. The drawer is a nicer pen for the same paper: it updates value
 *      cells in place by key, appends keys the sheet lacks, and never rewrites the tab. Rows this script does not
 *      know about, the `model` dropdown, notes and formatting all survive a save.
 *   2. "Valid" means exactly one thing: parseConfig_ accepts it. A draft is merged over the current raw values in
 *      memory and run through the same parser the pollers use. If it throws, nothing is written and that message
 *      goes back to the form, next to the field it names. Per-field checks (type, range, URL shape, folder
 *      reachability) run first so the person sees every problem at once rather than one per attempt.
 *   3. Locked keys (LOCKED_KEYS) are shown but never written, whatever the browser sends. The list is enforced here,
 *      not by the page's disabled inputs.
 *   4. Access fails closed. The web app runs as the deployer, so anyone who can open the page could otherwise edit
 *      the sheet as the deployer. config_allowed_emails names who may; empty means only the deployer.
 *   5. Concurrency: a save carries the revision (a hash of the values) the page was showing. If the sheet changed
 *      underneath, the save is refused and the person is asked to reload the form. The write itself runs under the
 *      script lock the pollers use, so a poll never reads a half-saved config.
 *   6. One `_logs` row per save (context 'config'): who saved, which keys changed. Values are not logged — the
 *      prompt is long and the sheet's version history already holds them.
 *
 * DEPLOY: clasp push, then a new web app version (Dashboard.html changed). Add Config key config_allowed_emails
 * if anyone other than the deployer should edit.
 */

/** @const {string} `_logs` context for saves. */
const CONFIG_LOG_CONTEXT = 'config';
/**
 * Keys shown in the drawer but never written from it. Infra wiring: changing these is a deployment, not a setting.
 * workato_test_url is not read by this script; it is listed so the drawer shows it read-only if the sheet has it.
 * @const {string[]}
 */
const LOCKED_KEYS = ['project_id', 'location', 'workato_webhook_url', 'workato_test_url'];

/**
 * @typedef {Object} FieldSpec
 * @property {string}  key       Config key (column A).
 * @property {string}  label     Shown on the form.
 * @property {string}  group     Section heading on the form.
 * @property {'text'|'multiline'|'list'|'bool'|'number'|'url'|'folder'} type
 * @property {boolean} [required]
 * @property {number}  [min]     number: inclusive lower bound.
 * @property {number}  [max]     number: inclusive upper bound.
 * @property {boolean} [integer] number: must be a whole number.
 * @property {string}  [help]    One line under the field.
 */

/**
 * Every key the drawer knows, in display order. Locked keys are included so the drawer can show them; LOCKED_KEYS
 * decides writability. Keys parseConfig_ reads but this list omits (workato_shared_secret, retired) are simply not
 * shown; the sheet row is untouched.
 * @const {FieldSpec[]}
 */
const CONFIG_SCHEMA = [
  // Folders
  { key: 'folder_id_ingestion', label: 'Intake folder',    group: 'Folders', type: 'folder', required: true, help: 'Contracts dropped here are picked up by the next poll.' },
  { key: 'folder_id_processed', label: 'Processed folder', group: 'Folders', type: 'folder', required: true, help: 'Originals move here after extraction.' },
  { key: 'folder_id_failed',    label: 'Failed folder',    group: 'Folders', type: 'folder', required: true, help: 'Originals move here when extraction fails.' },
  { key: 'folder_id_pending',   label: 'Pending folder',   group: 'Folders', type: 'folder', required: true, help: 'Review sheets waiting for approval.' },
  { key: 'folder_id_pushed',    label: 'Pushed folder',    group: 'Folders', type: 'folder', required: true, help: 'Review sheets after a successful push.' },
  { key: 'folder_id_cancelled', label: 'Cancelled folder', group: 'Folders', type: 'folder', required: true, help: 'Review sheets a reviewer cancelled.' },

  // Extraction
  { key: 'prompt_template',    label: 'Prompt',             group: 'Extraction', type: 'multiline', required: true, help: 'Sent before the field list. Applies to contracts extracted after you save; review sheets already in the queue are unaffected.' },
  { key: 'output_fields',      label: 'Fields to extract',  group: 'Extraction', type: 'list',      required: true, help: 'One per line, in the order they appear on the review sheet. Each label becomes a snake_case key on the wire, so two labels must not collapse to the same key.' },
  { key: 'system_instruction', label: 'System instruction', group: 'Extraction', type: 'multiline', help: 'Optional.' },

  // Model
  { key: 'project_id',      label: 'GCP project',    group: 'Model', type: 'text' },
  { key: 'location',        label: 'Vertex location', group: 'Model', type: 'text' },
  { key: 'model',           label: 'Model',          group: 'Model', type: 'text',   help: 'Blank uses the default. The list comes from Contract Intake > Refresh model list in the sheet; you may type one that is not listed.' },
  { key: 'temperature',     label: 'Temperature',    group: 'Model', type: 'number', min: 0, max: 2, help: 'Blank leaves it to the model.' },
  { key: 'max_tokens',      label: 'Max output tokens', group: 'Model', type: 'number', min: 1, integer: true, help: 'Blank leaves it to the model.' },
  { key: 'grounding',       label: 'Google Search grounding', group: 'Model', type: 'bool' },
  { key: 'grounding_debug', label: 'Log grounding metadata', group: 'Model', type: 'bool', help: 'Diagnostic; noisy.' },

  // Integrations
  { key: 'workato_webhook_url', label: 'Workato endpoint',      group: 'Integrations', type: 'url' },
  { key: 'workato_test_url',    label: 'Workato test endpoint', group: 'Integrations', type: 'url', help: 'Not used by this script.' },
  { key: 'chat_webhook_url',    label: 'Google Chat webhook',   group: 'Integrations', type: 'url', help: 'Optional. New review sheets are announced here.' },

  // Dashboard
  { key: 'upload_allowed_emails', label: 'Who may upload',       group: 'Dashboard', type: 'list', help: 'One email per line. Blank: anyone who can open the dashboard.' },
  { key: 'config_allowed_emails', label: 'Who may edit settings', group: 'Dashboard', type: 'list', help: 'One email per line. Blank: only the dashboard owner. The owner can always edit.' },
  { key: 'picker_url',            label: 'Drive picker URL',      group: 'Dashboard', type: 'url',  help: 'Optional. The DrivePicker helper\'s /exec URL; present turns on "Add from Drive". Takes effect on the next page load.' },
  { key: 'support_contact',       label: 'Support contact',       group: 'Dashboard', type: 'text', help: 'Who the dashboard tells people to ask for access or help.' }
];

// --- ENDPOINTS (google.script.run) ----------------------------------------------------------

/**
 * Everything the drawer needs to draw itself: the schema, the current values as strings, a revision token, and
 * whether the visitor may save. Viewers who may not edit still get the values — the drawer is read-only for them.
 * @return {{
 *   schema:FieldSpec[], locked:string[], values:Object.<string,string>, revision:string,
 *   canEdit:boolean, viewer:string, runsAs:string, contact:string, models:string[]
 * }}
 */
function getConfigForEdit() {
  const sheet = getConfigSheet_();
  const read = readConfigRaw_(sheet);
  const cfg = tryParse_(read.raw);          // null if the sheet is currently invalid; the drawer still opens
  const who = viewerEmail_();
  const runsAs = emailOf_(function () { return Session.getEffectiveUser(); });
  const allowed = cfg ? cfg.config_allowed_emails : parseList_(read.raw.config_allowed_emails).map(function (e) { return e.toLowerCase(); });

  return {
    schema: CONFIG_SCHEMA,
    locked: LOCKED_KEYS,
    values: displayValues_(read.raw),
    revision: configRevision_(read),
    canEdit: canEditConfig_(who, allowed, runsAs),
    viewer: who,
    runsAs: runsAs,
    contact: cfg ? cfg.support_contact : str_(read.raw.support_contact),
    models: readModelIds_(sheet.getParent())
  };
}

/**
 * Dry run: what saveConfig would say, without the write, the lock, or the revision check.
 * @param {Object.<string,string>} draft Key -> string, editable keys only.
 * @return {{ok:boolean, errors:Object.<string,string>, message:string, changed:string[]}}
 */
function validateConfigDraft(draft) {
  assertConfigEditAllowed_(viewerEmail_(), currentConfigAllowList_(), emailOf_(function () { return Session.getEffectiveUser(); }));
  const read = readConfigRaw_(getConfigSheet_());
  return checkDraft_(draft, read.raw);
}

/**
 * Validate, then write the changed cells under the script lock. Refuses if the sheet changed since `revision` was
 * issued. Returns the outcome the page renders; only genuine failures (access, lock) throw.
 * @param {Object.<string,string>} draft Key -> string, editable keys only.
 * @param {string} revision The token getConfigForEdit returned to the page.
 * @return {{ok:boolean, errors:Object.<string,string>, message:string, changed:string[], revision:string, stale:boolean}}
 */
function saveConfig(draft, revision) {
  const who = viewerEmail_();
  const runsAs = emailOf_(function () { return Session.getEffectiveUser(); });
  assertConfigEditAllowed_(who, currentConfigAllowList_(), runsAs);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The pipeline is running right now; try saving again in a moment.');
  try {
    const sheet = getConfigSheet_();
    const read = readConfigRaw_(sheet);
    const current = configRevision_(read);
    if (revision !== current) {
      return { ok: false, stale: true, errors: {}, changed: [],
               message: 'The configuration changed since you opened this — someone else saved, or the sheet was edited. Reload the form to see the current values.',
               revision: current };
    }

    const result = checkDraft_(draft, read.raw);
    if (!result.ok) { result.revision = current; result.stale = false; return result; }

    result.changed.forEach(function (k) { writeConfigCell_(sheet, k, result.merged[k]); });
    SpreadsheetApp.flush();

    const after = readConfigRaw_(sheet);
    logInfo_(CONFIG_LOG_CONTEXT, 'Config saved by ' + (who || runsAs || 'unknown'), '',
             result.changed.length ? 'changed: ' + result.changed.join(', ') : 'no changes');
    return { ok: true, stale: false, errors: {}, changed: result.changed, revision: configRevision_(after),
             message: result.changed.length ? 'Saved.' : 'Nothing changed.' };
  } finally {
    lock.releaseLock();
  }
}

// --- DRAFT CHECKING (pure apart from folder lookups) ----------------------------------------

/**
 * Coerce and check a draft against the schema, merge it over the current raw values, and run parseConfig_ on the
 * result. Locked keys and keys not in the schema are ignored. Only changed folder keys are looked up in Drive.
 * @param {Object.<string,string>} draft
 * @param {Object.<string,*>} raw Current sheet values.
 * @param {function(string):boolean} [folderExists] Injected for tests; defaults to a DriveApp lookup.
 * @return {{ok:boolean, errors:Object.<string,string>, message:string, changed:string[], merged:Object.<string,*>}}
 * @private
 */
function checkDraft_(draft, raw, folderExists) {
  draft = draft || {};
  folderExists = folderExists || folderExists_;
  const errors = {};
  const merged = {};
  const changed = [];
  Object.keys(raw).forEach(function (k) { merged[k] = raw[k]; });

  editableSpecs_().forEach(function (spec) {
    if (!(spec.key in draft)) return;                            // untouched by the page: keep the sheet's value
    const coerced = coerceField_(spec, draft[spec.key]);
    if (coerced.error) { errors[spec.key] = coerced.error; return; }
    if (!differs_(spec, coerced.value, raw[spec.key])) return;               // no change
    if (spec.type === 'folder' && coerced.value && !folderExists(coerced.value)) {
      errors[spec.key] = 'No folder with this ID is reachable by the dashboard owner.';
      return;
    }
    merged[spec.key] = coerced.value;
    changed.push(spec.key);
  });

  if (!Object.keys(errors).length) {
    try { parseConfig_(merged); }
    catch (err) {
      const key = errorKey_(err.message);
      if (key) errors[key] = err.message; else errors._ = err.message;
    }
  }

  const n = Object.keys(errors).length;
  return {
    ok: n === 0,
    errors: errors,
    changed: changed,
    merged: merged,
    message: n ? (n === 1 ? 'One field needs attention.' : n + ' fields need attention.') : ''
  };
}

/**
 * Turn the string the form sent into the value the cell should hold, or an error. Pure.
 * @param {FieldSpec} spec
 * @param {*} input
 * @return {{value:*, error:string}}
 * @private
 */
function coerceField_(spec, input) {
  const s = spec.type === 'multiline' ? String(input == null ? '' : input) : str_(input);
  if (spec.required && !s) return { value: '', error: 'Required.' };
  switch (spec.type) {
    case 'bool':
      return { value: asBool_(s), error: '' };
    case 'number': {
      if (!s) return { value: '', error: '' };
      const n = Number(s);
      if (isNaN(n)) return { value: '', error: 'Must be a number.' };
      if (spec.integer && n !== Math.floor(n)) return { value: '', error: 'Must be a whole number.' };
      if (spec.min != null && n < spec.min) return { value: '', error: 'Must be at least ' + spec.min + '.' };
      if (spec.max != null && n > spec.max) return { value: '', error: 'Must be at most ' + spec.max + '.' };
      return { value: n, error: '' };
    }
    case 'url':
      if (s && !/^https:\/\/\S+$/.test(s)) return { value: '', error: 'Must be an https:// URL.' };
      return { value: s, error: '' };
    case 'list':
      return { value: parseList_(s).join('\n'), error: '' };
    case 'folder':
      if (s && !/^[\w-]{10,}$/.test(s)) return { value: '', error: 'Must be a Drive folder ID (the part after /folders/ in its URL).' };
      return { value: s, error: '' };
    default:
      return { value: s, error: '' };
  }
}

/**
 * Whether a coerced draft value would change the cell. The cell's value is coerced the same way first, so
 * "A, B" and "A\nB" are one list, TRUE and 'true' one boolean, and an unticked box over a blank cell no change.
 * A cell the schema cannot coerce (garbage in a number cell) counts as different so a save can repair it. Pure.
 * @param {FieldSpec} spec
 * @param {*} proposed Output of coerceField_.
 * @param {*} cell     Raw sheet value.
 * @return {boolean}
 * @private
 */
function differs_(spec, proposed, cell) {
  const base = coerceField_(spec, displayValue_(cell));
  if (base.error) return true;
  return displayValue_(proposed) !== displayValue_(base.value);
}

/**
 * Which field a parseConfig_ error is about, or '' when it is about the whole config. Pure.
 * @param {string} message
 * @return {string}
 * @private
 */
function errorKey_(message) {
  const m = String(message || '');
  let hit = m.match(/missing required key: (\w+)/);
  if (hit) return hit[1];
  if (/output_fields/.test(m)) return 'output_fields';
  return '';
}

/**
 * Whether `who` may save Config. The deployer always may; otherwise `who` must be on the list. Empty list = no one
 * but the deployer. Pure.
 * @param {string} who     Visitor email, lower-cased ('' if withheld).
 * @param {string[]} allowed Lower-cased emails.
 * @param {string} runsAs  Effective-user email, lower-cased ('' if withheld).
 * @return {boolean}
 * @private
 */
function canEditConfig_(who, allowed, runsAs) {
  if (!who) return false;
  if (runsAs && who === runsAs) return true;
  return (allowed || []).indexOf(who) !== -1;
}

/**
 * @param {string} who
 * @param {string[]} allowed
 * @param {string} runsAs
 * @throws {Error} With a message the page classifies as 'permission'.
 * @private
 */
function assertConfigEditAllowed_(who, allowed, runsAs) {
  if (!canEditConfig_(who, allowed, runsAs)) {
    throw new Error('Your account is not on the settings list for this tool.' + (who ? ' (' + who + ')' : ''));
  }
}

// --- SHEET I/O ------------------------------------------------------------------------------

/**
 * Write one value cell by key: update in place if the key row exists, else append a new row. The `model` dropdown
 * and any note survive because setValue does not touch validation or notes.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} key
 * @param {*} value
 * @private
 */
function writeConfigCell_(sheet, key, value) {
  const cell = configValueCell_(sheet.getParent(), key);
  if (cell) cell.setValue(value);
  else sheet.appendRow([key, value]);
}

/**
 * A short token that changes whenever any key or value on the tab does. Keys in sheet order, values as strings.
 * @param {{raw:Object.<string,*>, order:string[]}} read
 * @return {string} 32 hex chars.
 * @private
 */
function configRevision_(read) {
  const text = read.order.map(function (k) { return k + '\u0001' + displayValue_(read.raw[k]); }).join('\u0002');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/**
 * The string the form shows for a cell value: booleans as 'true'/'false', numbers as typed, dates as ISO, blanks
 * as ''. The same function is used to decide whether a draft value differs from the cell, so what the person sees
 * is what is compared.
 * @param {*} v
 * @return {string}
 * @private
 */
function displayValue_(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Only the keys the drawer shows, as strings. Rows the schema does not know are left out of the payload (and left
 * alone on the sheet).
 * @param {Object.<string,*>} raw
 * @return {Object.<string,string>}
 * @private
 */
function displayValues_(raw) {
  const out = {};
  CONFIG_SCHEMA.forEach(function (spec) { out[spec.key] = displayValue_(raw[spec.key]); });
  return out;
}

/**
 * Schema entries the page may write. Pure.
 * @return {FieldSpec[]}
 * @private
 */
function editableSpecs_() {
  return CONFIG_SCHEMA.filter(function (spec) { return LOCKED_KEYS.indexOf(spec.key) === -1; });
}

/**
 * Model ids from the `_models` tab, for the drawer's suggestion list; [] if the tab is absent.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {string[]}
 * @private
 */
function readModelIds_(ss) {
  try {
    const sheet = ss.getSheetByName(MODELS_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .map(function (r) { return str_(r[0]); }).filter(Boolean);
  } catch (e) { return []; }
}

/**
 * parseConfig_ or null. The drawer must open on an invalid sheet — fixing it is the point.
 * @param {Object.<string,*>} raw
 * @return {?Config}
 * @private
 */
function tryParse_(raw) {
  try { return parseConfig_(raw); } catch (e) { return null; }
}

/**
 * config_allowed_emails as currently on the sheet, read leniently so the gate works even when the rest of the
 * config is invalid.
 * @return {string[]}
 * @private
 */
function currentConfigAllowList_() {
  const raw = readConfigRaw_(getConfigSheet_()).raw;
  return parseList_(raw.config_allowed_emails).map(function (e) { return e.toLowerCase(); });
}

/**
 * Visitor's email, lower-cased, '' if withheld. Same source Intake.gs uses for uploads.
 * @return {string}
 * @private
 */
function viewerEmail_() {
  return emailOf_(function () { return Session.getActiveUser(); });
}

/**
 * Whether the running account can open a folder by id.
 * @param {string} id
 * @return {boolean}
 * @private
 */
function folderExists_(id) {
  try { DriveApp.getFolderById(id).getName(); return true; } catch (e) { return false; }
}
