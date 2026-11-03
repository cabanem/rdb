/**
 * @file definitions/Config.gs
 * The Config tab: locating the spreadsheet, reading the raw cells, and parseConfig_ — the one parser the pollers
 * and the Settings drawer both trust. Everything below readConfig_ is pure.
 */

// --- CONSTANTS -----------------------------------------------------------------------------------
/** @const {string} Name of the configuration tab. */
const CONFIG_SHEET_NAME = 'Config';

// --- READ ----------------------------------------------------------------------------------------
/**
 * The active config spreadsheet. Uses Script Property CONFIG_SHEET_ID when set,
 * otherwise the bound spreadsheet. Independent of {@link readConfig_} so it works
 * even while diagnosing a config failure.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @private
 */
function getConfigSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Read the Config tab into a typed object. Thin: reads the cells, then hands them to {@link parseConfig_}.
 * @return {Config}
 * @throws {Error} If the Config sheet or a required key is missing.
 * @private
 */
function readConfig_() {
  return parseConfig_(readConfigRaw_(getConfigSheet_()).raw);
}

/**
 * The Config tab of the active config spreadsheet.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} If the tab is missing.
 * @private
 */
function getConfigSheet_() {
  const sheet = getConfigSpreadsheet_().getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + CONFIG_SHEET_NAME + '" sheet.');
  return sheet;
}

/**
 * Column A/B of the Config tab as a key -> raw cell value map, plus the keys in sheet order (for stable hashing and
 * for preserving rows this script does not know about). Blank keys are skipped; a duplicated key keeps the last row,
 * as it always has.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {{raw:Object.<string,*>, order:string[]}}
 * @private
 */
function readConfigRaw_(sheet) {
  const raw = {};
  const order = [];
  sheet.getDataRange().getValues().forEach(function (r) {
    const k = String(r[0] || '').trim();
    if (!k) return;
    if (!(k in raw)) order.push(k);
    raw[k] = r[1];
  });
  return { raw: raw, order: order };
}

// --- PARSE (PURE) --------------------------------------------------------------------------------
/**
 * Turn raw Config cell values into a typed object. PURE: the same function validates a proposed config from the
 * dashboard's Settings drawer before anything is written, so the form and the pollers can never disagree about
 * what is acceptable. Returns EVERY key this flow uses — no fixed whitelist that silently drops folder/webhook
 * keys — and validates the genuinely required ones.
 * @param {Object.<string,*>} raw Key -> cell value, as read by {@link readConfigRaw_}.
 * @return {Config}
 * @throws {Error} If a required key is missing or output_fields collide.
 * @private
 */
function parseConfig_(raw) {
  raw = raw || {};
  const of = parseOutputFields_(parseList_(raw.output_fields));   // throws on a collision
  const cfg = {
    folder_id_ingestion: str_(raw.folder_id_ingestion),
    folder_id_processed: str_(raw.folder_id_processed),
    folder_id_failed: str_(raw.folder_id_failed),
    folder_id_pending: str_(raw.folder_id_pending),
    folder_id_pushed: str_(raw.folder_id_pushed),
    folder_id_cancelled: str_(raw.folder_id_cancelled),

    prompt_template: String(raw.prompt_template || ''),
    output_fields: of.labels,
    field_keys: of.keys,
    field_roles: of.roles,
    required_fields: parseList_(raw.required_fields),
    blank_phrases: raw.blank_phrases == null ? DEFAULT_BLANK_PHRASES.slice() : parseList_(raw.blank_phrases),
    opportunity_search_label: str_(raw.opportunity_search_label),
    contract_owner_email: str_(raw.contract_owner_email).toLowerCase(),
    system_instruction: str_(raw.system_instruction),

    project_id: str_(raw.project_id),
    location: str_(raw.location) || 'global',
    vertex_service_account: str_(raw.vertex_service_account),
    model: str_(raw.model),
    temperature: isFilled_(raw.temperature) ? Number(raw.temperature) : undefined,
    max_tokens: isFilled_(raw.max_tokens) ? Number(raw.max_tokens) : undefined,
    grounding: isFilled_(raw.grounding) ? asBool_(raw.grounding) : false,
    grounding_debug: isFilled_(raw.grounding_debug) ? asBool_(raw.grounding_debug) : false,

    workato_webhook_url: str_(raw.workato_webhook_url),
    workato_schema_url: str_(raw.workato_schema_url),
    workato_search_url: str_(raw.workato_search_url),
    chat_webhook_url: str_(raw.chat_webhook_url),

    upload_allowed_emails: parseList_(raw.upload_allowed_emails).map(function (e) { return e.toLowerCase(); }),
    config_allowed_emails: parseList_(raw.config_allowed_emails).map(function (e) { return e.toLowerCase(); }),

    picker_url: str_(raw.picker_url),
    guide_url: str_(raw.guide_url),

    support_contact: str_(raw.support_contact)
  };

  const required = [
    'folder_id_ingestion',
    'folder_id_processed',
    'folder_id_failed',
    'folder_id_pending',
    'folder_id_pushed',
    'folder_id_cancelled',
    'prompt_template',
    'project_id',
    'workato_webhook_url'
  ];
  required.forEach(function (k) { if (!cfg[k]) throw new Error('Config missing required key: ' + k); });
  if (!cfg.output_fields.length) throw new Error('Config missing required key: output_fields');

  // required_fields and opportunity_search_label name review-sheet rows, so each must resolve to an output_fields
  // line (by its label, or by the Salesforce label on its alias). Failing here keeps a typo visible in the drawer
  // instead of silently never blocking a push.
  cfg.required_fields = cfg.required_fields.map(function (entry) {
    const label = resolveFieldLabel_(cfg, entry);
    if (!label) throw new Error('required_fields: "' + entry + '" is not one of output_fields');
    return label;
  });
  if (cfg.opportunity_search_label) {
    const label = resolveFieldLabel_(cfg, cfg.opportunity_search_label);
    if (!label) throw new Error('opportunity_search_label: "' + cfg.opportunity_search_label + '" is not one of output_fields');
    cfg.opportunity_search_label = label;
  }
  if (cfg.contract_owner_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.contract_owner_email)) {
    throw new Error('contract_owner_email: "' + cfg.contract_owner_email + '" is not an email address');
  }

  return cfg;
}

/**
 * The output_fields label a Config entry refers to: the label itself, or the label whose alias target snakes to
 * the same wire key ("Countries Supplying Services" finds "Countries where services"). Case-insensitive. Pure.
 * @param {Config} cfg Needs output_fields and field_keys.
 * @param {string} entry A label or a Salesforce label.
 * @return {string} The matching output_fields label, or '' if none.
 * @private
 */
function resolveFieldLabel_(cfg, entry) {
  const want = str_(entry).toLowerCase();
  if (!want) return '';
  const labels = cfg.output_fields || [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].toLowerCase() === want) return labels[i];
  }
  const key = toSnake_(entry);
  for (let i = 0; i < labels.length; i++) {
    if (wireKey_(cfg, labels[i]) === key) return labels[i];
  }
  return '';
}

/**
 * The output_fields labels that take a given role. Pure.
 * @param {Config} cfg
 * @param {string} role 'extract' | 'manual' | 'info'
 * @return {string[]}
 * @private
 */
function labelsWithRole_(cfg, role) {
  const roles = (cfg && cfg.field_roles) || {};
  return ((cfg && cfg.output_fields) || []).filter(function (l) { return (roles[l] || 'extract') === role; });
}

/**
 * The role of one output_fields label: 'extract' (default: prompted, shown, pushed), 'manual' (reviewer-entered:
 * not prompted, Extracted blank, pushed) or 'info' (prompted and shown for the reviewer, never pushed). Pure.
 * @param {Config} cfg
 * @param {string} label
 * @return {string}
 * @private
 */
function fieldRole_(cfg, label) {
  return ((cfg && cfg.field_roles) || {})[label] || 'extract';
}

/**
 * @const {string[]} What the model writes for a field it could not find, despite being told to leave it empty.
 * Config `blank_phrases` overrides; these apply when the key is absent. Matched whole, case-insensitively,
 * ignoring surrounding whitespace and a trailing period.
 */
const DEFAULT_BLANK_PHRASES = ['Not mentioned in the document', 'Not mentioned', 'Not specified', 'Not stated',
  'Not provided', 'Not applicable', 'N/A', 'None'];

/**
 * True when an extracted value is one of the configured "nothing here" phrases, i.e. the model's way of leaving
 * a section empty. Such a value is shown in the Extracted column but never seeded into Approved or sent. Pure.
 * @param {Config} cfg Needs blank_phrases.
 * @param {*} value
 * @return {boolean}
 * @private
 */
function isAbsentPhrase_(cfg, value) {
  const norm = function (v) { return str_(v).toLowerCase().replace(/[\s.]+$/, '').replace(/^\s+/, ''); };
  const s = norm(value);
  if (!s) return false;
  return ((cfg && cfg.blank_phrases) || []).some(function (p) { return norm(p) === s; });
}

/** @const {RegExp} Trailing role marker on an output_fields line: "[manual]" or "[info]", any case. */
const OUTPUT_FIELD_ROLE = /\s*\[\s*(manual|info)\s*\]\s*$/i;

/**
 * Split output_fields lines into {labels, keys, roles}. A line "Label => Salesforce label" keeps Label for the
 * prompt and the review sheet and derives the wire key from the Salesforce label. A bare line derives it from the
 * label. A trailing "[manual]" marks a reviewer-entered field (not prompted; the Approved cell is the only input)
 * and "[info]" a prompt-only field (shown to the reviewer, never pushed). Pure.
 * @param {string[]} lines
 * @return {{labels:string[], keys:Object.<string,string>, roles:Object.<string,string>}} roles holds only the
 *     non-default ones ('manual' | 'info'); absent = 'extract'.
 * @throws {Error} If two lines collapse on the same wire key.
 */
function parseOutputFields_(lines) {
  const labels = [], keys = {}, roles = {}, seen = {};
  lines.forEach(function (line) {
    let role = '';
    const body = String(line).replace(OUTPUT_FIELD_ROLE, function (m, r) { role = r.toLowerCase(); return ''; });
    const parts = body.split('=>');
    const label = parts[0].trim();
    const target = parts.length > 1 ? parts.slice(1).join('=>').trim() : label;
    if (!label || !target) throw new Error('output_fields: bad line "' + line + '"');
    const key = toSnake_(target);
    if (seen[key]) throw new Error('output_fields collide on API key "' + key + '": "' + seen[key] + '" and "' + label + '"');
    seen[key] = label;
    labels.push(label);
    keys[label] = key;
    if (role) roles[label] = role;
  });
  return { labels: labels, keys: keys, roles: roles };
}

/**
 * Trim and stringify a cell value; null/undefined → ''.
 * @param {*} v
 * @return {string}
 * @private
 */
function str_(v) { return v == null ? '' : String(v).trim(); }

/**
 * Whether a cell value is present (note: 0 counts as filled).
 * @param {*} v
 * @return {boolean}
 * @private
 */
function isFilled_(v) { return v !== '' && v != null; }

/**
 * Coerce a cell value to boolean ('true'/'yes'/'1' → true).
 * @param {*} v
 * @return {boolean}
 * @private
 */
function asBool_(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1'].indexOf(String(v).trim().toLowerCase()) !== -1;
}

/**
 * Split a single config cell into a trimmed list on commas/newlines.
 * @param {*} v
 * @return {string[]}
 * @private
 */
function parseList_(v) {
  if (!isFilled_(v)) return [];
  return String(v).split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}
