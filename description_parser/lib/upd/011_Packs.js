/**
 * @file 011_Packs.gs (SDC library)
 * Field packs: a reviewed, config-shaped Google Sheet per VMS x record type, applied into an
 * implementation workbook so the analyst starts from a filled 4_fields instead of a blank one.
 *
 * A pack is a Sheet with the workbook's own tabs (4_fields, 4_complex_validations, 5_lookups) plus:
 *   _pack       key / value rows: pack_id, vms, record_type, vms_spec_date, pack_version, schema_version, reviewed_by
 *   _questions  question_id, prompt, field, effect      (effect: required | include | include+required)
 *   _review     curator notes; never read by the library
 *
 * Packs are read-only to analysts. Packs.apply copies rows OUT of the pack into the open workbook.
 * A client-specific change is made in the workbook, never in the pack.
 *
 * Pipeline (Packs.apply):
 *   Config.build -> Packs.read -> Packs.plan -> write tabs (under a document lock) ->
 *   stamp _developer_settings -> PrimaryKey.backfill (fills any id still blank) -> Validate.run
 *
 * Public:
 *   Packs.list(config)                          -> [{ fileId, name, pack_id, vms, record_type, pack_version, vms_spec_date }]
 *   Packs.read(fileId)                          -> pack object (see Packs._readPack)
 *   Packs.plan(pack, answers, scope, mode)      -> { fields, rules, lookups, stamps, warnings }   PURE: no Sheets calls
 *   Packs.apply(ss, opts)                       -> Result
 *       opts.fileId   pack Sheet id (required)
 *       opts.answers  { question_id: true|false }         default: every question false
 *       opts.scope    [field names to keep] | null         default: every field
 *       opts.mode     'standard' | 'discovery'             default: 'standard' (discovery sets Strict? FALSE on every row)
 *       opts.replace  true to overwrite a 4_fields that already has rows   default: false -> fail with stage 'guard'
 *
 * Layout is located by anchor text ('_pk_fields_', '_pk_rules_', '_pk_lookup_table_' or 'Table name'), not by fixed
 * row numbers, so the same code reads a pack Sheet and writes an implementation workbook.
 */

var Packs = {};

var PACK_FIELD_HEADERS = ['Field name', 'Data type', 'Data format', 'Description', 'Required', 'Read-only', 'Unique',
  'Lookup name', 'Depends on', 'Field length validation', 'Numeric field validation', 'Date field validation',
  'Field input validation', 'Data cleaning flags', 'Strict?', 'Hidden'];
var PACK_RULE_HEADERS = ['Target field', 'Rule or action', 'Condition field', 'Condition value', 'Default error message',
  'Custom error message', 'Strict?'];
var PACK_LOOKUP_HEADERS = ['Table name', 'Code', 'Value', 'Label', 'Parent value', 'Record active?', 'Project specific?'];
var PACK_BOOL_FIELDS = { 'Required': 1, 'Read-only': 1, 'Unique': 1, 'Strict?': 1, 'Hidden': 1, 'Record active?': 1, 'Project specific?': 1 };
var PACK_MODES = { standard: 1, discovery: 1 };

// --- list ------------------------------------------------------------

/**
 * Packs available to this workbook: every Sheet in config.storage.packsFolderId that has a _pack tab.
 * @param {Object} config  Config.build(ss) result; needs storage.packsFolderId
 */
Packs.list = function(config) {
  var folderId = config && config.storage && config.storage.packsFolderId;
  if (!folderId) { var e = new Error('storage.packsFolderId is not set in _developer_settings.'); e.stage = 'config'; throw e; }
  var out = [];
  var files = DriveApp.getFolderById(folderId).getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) {
    var f = files.next();
    try {
      var meta = Packs._readMeta(SpreadsheetApp.openById(f.getId()));
      if (meta.pack_id) out.push({ fileId: f.getId(), name: f.getName(), pack_id: meta.pack_id, vms: meta.vms,
        record_type: meta.record_type, pack_version: meta.pack_version, vms_spec_date: meta.vms_spec_date });
    } catch (ignore) { /* not a pack */ }
  }
  out.sort(function(a, b) { return (a.vms + a.record_type).localeCompare(b.vms + b.record_type); });
  return out;
};

// --- read ------------------------------------------------------------

/**
 * Read a pack Sheet into a plain object.
 * @returns {{ meta:Object, fields:Object[], rules:Object[], lookups:Object[], questions:Object[] }}
 *   fields / rules / lookups are arrays of { header: value } objects keyed by the PACK_*_HEADERS names.
 */
Packs.read = function(fileId) {
  if (!fileId) throw new Error('Packs.read: fileId is required.');
  var ss = SpreadsheetApp.openById(fileId);
  return Packs._readPack(ss);
};

Packs._readPack = function(ss) {
  var meta = Packs._readMeta(ss);
  var fields  = Packs._readTable(ss.getSheetByName('4_fields'), ['_pk_fields_', 'Field name'], PACK_FIELD_HEADERS, 'Field name');
  var rules   = Packs._readTable(ss.getSheetByName('4_complex_validations'), ['_pk_rules_', 'Target field'], PACK_RULE_HEADERS, 'Target field');
  var lookups = Packs._readTable(ss.getSheetByName('5_lookups'), ['_pk_lookup_table_', 'Table name'], PACK_LOOKUP_HEADERS, 'Table name');
  var qs = ss.getSheetByName('_questions');
  var questions = qs ? Packs._readTable(qs, ['question_id'], ['question_id', 'prompt', 'field', 'effect'], 'question_id') : [];
  return { meta: meta, fields: fields, rules: rules, lookups: lookups, questions: questions };
};

Packs._readMeta = function(ss) {
  var sh = ss.getSheetByName('_pack');
  if (!sh) throw new Error('Not a pack: no _pack tab.');
  var meta = {};
  sh.getDataRange().getValues().forEach(function(r) { var k = String(r[0] || '').trim(); if (k && k !== 'key') meta[k] = r[1]; });
  return meta;
};

/**
 * Read a header-anchored table. The header row is the first row containing any of anchors; columns are
 * matched by header text so column order and spacer columns do not matter. Rows with a blank keyHeader are skipped.
 */
Packs._readTable = function(sheet, anchors, headers, keyHeader) {
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var loc = Packs._locate(data, anchors, headers);
  if (!loc) return [];
  var out = [];
  for (var r = loc.headerRow + 1; r < data.length; r++) {
    var row = data[r], obj = {}, key = row[loc.cols[keyHeader]];
    if (key === '' || key === null || key === undefined) continue;
    headers.forEach(function(h) {
      var c = loc.cols[h]; var v = c === undefined ? '' : row[c];
      if (PACK_BOOL_FIELDS[h]) v = Util.coerceTruthy(v);
      else if (v === null || v === undefined) v = '';
      obj[h] = v;
    });
    out.push(obj);
  }
  return out;
};

/** Find the header row and a header -> column index map. Returns null when no anchor is found. */
Packs._locate = function(data, anchors, headers) {
  var norm = function(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' '); };
  var wantA = anchors.map(norm), wantH = headers.map(norm);
  for (var r = 0; r < Math.min(data.length, 40); r++) {
    var cells = data[r].map(norm);
    var hit = wantA.some(function(a) { return cells.indexOf(a) >= 0; });
    if (!hit) continue;
    var cols = {};
    headers.forEach(function(h, k) { var i = cells.indexOf(wantH[k]); if (i >= 0) cols[h] = i; });
    if (cols[headers[0]] === undefined) continue;                  // anchor matched but the header row is elsewhere
    // primary-key column: the "_pk_..." header, or (older 5_lookups layout) the header-less column right after Table name
    var pkCol = -1;
    cells.forEach(function(c, i) { if (pkCol < 0 && /^_pk_/.test(c)) pkCol = i; });
    if (pkCol < 0 && cols['Table name'] !== undefined && cells[cols['Table name'] + 1] === '') pkCol = cols['Table name'] + 1;
    return { headerRow: r, cols: cols, pkCol: pkCol };
  }
  return null;
};

// --- plan (pure) ----------------------------------------------------

/**
 * Turn a pack plus the analyst's decisions into the rows to write. No Sheets calls, so it is unit-testable.
 *
 * answers: { question_id: boolean }. Effects on a "yes":
 *   required          tick Required on the field
 *   include           keep the field (a "no" drops it)
 *   include+required  both
 * scope: array of field names to keep, or null for all. Applied after questions.
 * mode:  'discovery' sets Strict? FALSE on every field and rule.
 *
 * Rules whose target or condition field is dropped are dropped too. Lookup tables no field references are dropped.
 */
Packs.plan = function(pack, answers, scope, mode) {
  answers = answers || {}; mode = mode || 'standard';
  if (!PACK_MODES[mode]) throw new Error('Packs.plan: mode must be standard or discovery, got ' + mode);
  var warnings = [];
  var byName = {};
  pack.fields.forEach(function(f) { byName[f['Field name']] = Packs._clone(f); });

  // questions
  var drop = {};
  pack.questions.forEach(function(q) {
    var f = byName[q.field];
    if (!f) { warnings.push('_questions names a field that is not in 4_fields: ' + q.field); return; }
    var yes = answers[q.question_id] === true;
    var eff = String(q.effect || '').toLowerCase();
    if (eff.indexOf('include') >= 0 && !yes) drop[q.field] = true;
    if (eff.indexOf('required') >= 0 && yes) f['Required'] = true;
  });

  // scope
  var keep = null;
  if (scope && scope.length) { keep = {}; scope.forEach(function(n) { keep[n] = true; }); }
  var fields = pack.fields.map(function(f) { return byName[f['Field name']]; }).filter(function(f) {
    var n = f['Field name'];
    if (drop[n]) return false;
    if (keep && !keep[n]) return false;
    return true;
  });
  var present = {}; fields.forEach(function(f) { present[f['Field name']] = true; });

  // rules and lookups that still make sense
  var rules = pack.rules.filter(function(r) {
    var ok = present[r['Target field']] && (!r['Condition field'] || present[r['Condition field']]);
    if (!ok) warnings.push('rule dropped with its field: ' + r['Target field'] + ' / ' + r['Rule or action']);
    return ok;
  }).map(Packs._clone);
  var used = {}; fields.forEach(function(f) { if (f['Lookup name']) used[String(f['Lookup name']).trim()] = true; });
  var lookups = pack.lookups.filter(function(l) { return used[String(l['Table name']).trim()]; }).map(Packs._clone);
  fields.forEach(function(f) {
    if (f['Lookup name'] && !pack.lookups.some(function(l) { return String(l['Table name']).trim() === String(f['Lookup name']).trim(); }))
      warnings.push('field "' + f['Field name'] + '" names lookup "' + f['Lookup name'] + '" which the pack does not carry');
  });

  if (mode === 'discovery') { fields.forEach(function(f) { f['Strict?'] = false; }); rules.forEach(function(r) { r['Strict?'] = false; }); }

  var stamps = { pack_id: pack.meta.pack_id, pack_version: pack.meta.pack_version, collection_mode: mode,
                 pack_applied_at: new Date().toISOString() };
  return { fields: fields, rules: rules, lookups: lookups, stamps: stamps, warnings: warnings };
};

Packs._clone = function(o) { var c = {}; Object.keys(o).forEach(function(k) { c[k] = o[k]; }); return c; };

// --- apply -----------------------------------------------------------

/**
 * Apply a pack into the open workbook. See file header for opts.
 * @returns {Object} Result (flow 'pack-apply'); data carries plan counts and Validate's verdict.
 */
Packs.apply = function(ss, opts) {
  if (!ss) throw new Error('Packs.apply: ss is required.');
  opts = opts || {};
  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  log('INFO', 'Applying field pack ' + (opts.fileId || '?') + ' (' + (opts.mode || 'standard') + ')');

  var lock = LockService.getDocumentLock();
  try {
    if (!lock.tryLock(30000)) { var eL = new Error('Another apply is running on this workbook. Try again in a minute.'); eL.stage = 'lock'; throw eL; }

    var config = Stage.run('config', function() { return Config.build(ss); });
    var pack   = Stage.run('read-pack', function() { return Packs.read(opts.fileId); });

    Stage.run('guard', function() {
      var wbSchema = String(config.schemaVersion), packSchema = String(pack.meta.schema_version || '');
      if (packSchema && packSchema.split('.')[0] !== wbSchema.split('.')[0])
        throw new Error('Pack schema ' + packSchema + ' does not match workbook schema ' + wbSchema + '.');
      var existing = Packs._readTable(ss.getSheetByName(config.sheets.fields), ['_pk_fields_', 'Field name'], PACK_FIELD_HEADERS, 'Field name');
      if (existing.length && !opts.replace)
        throw new Error('4_fields already has ' + existing.length + ' rows. Pass replace: true to overwrite them.');
    });

    var plan = Stage.run('plan', function() { return Packs.plan(pack, opts.answers, opts.scope, opts.mode); });

    var written = {};
    Stage.run('write-fields', function() {
      written.fields = Packs._writeTable(ss.getSheetByName(config.sheets.fields), ['_pk_fields_', 'Field name'], PACK_FIELD_HEADERS, plan.fields);
    });
    Stage.run('write-rules', function() {
      written.rules = Packs._writeTable(ss.getSheetByName(config.sheets.validations), ['_pk_rules_', 'Target field'], PACK_RULE_HEADERS, plan.rules);
    });
    Stage.run('write-lookups', function() {
      // MERGE: the master ships shared tables (countries, months, ...) that no pack carries. Replace only the tables
      // this pack carries; keep every other table; append the pack's rows after the existing ones.
      written.lookups = Packs._mergeLookups(ss.getSheetByName(config.sheets.lookups), plan.lookups);
    });
    Stage.run('stamp', function() { Packs._stamp(ss, plan.stamps); });
    log('INFO', 'Wrote ' + written.fields.rows + ' field rows from row ' + written.fields.firstRow + ', ' + written.rules.rows + ' rule rows from row ' +
        written.rules.firstRow + ', ' + written.lookups.rows + ' lookup rows from row ' + written.lookups.firstRow + ' (' + written.lookups.kept + ' existing rows kept).');

    Stage.run('primary-key-backfill', function() { return PrimaryKey.backfill(ss); });
    var validation = Stage.run('validate', function() { return Validate.run(ss); });

    var msg = 'Applied ' + pack.meta.pack_id + ' v' + pack.meta.pack_version + ': ' + plan.fields.length + ' fields, ' +
              plan.rules.length + ' rules, ' + plan.lookups.length + ' lookup rows (' + plan.stamps.collection_mode + ' mode).';
    log('SUCCESS', msg);
    return Result.ok({ flow: 'pack-apply', correlationId: correlationId, message: msg, warnings: plan.warnings,
      data: { pack: pack.meta, counts: { fields: plan.fields.length, rules: plan.rules.length, lookups: plan.lookups.length },
              validationResult: validation && validation.data ? validation.data.validationResult : null } });
  } catch (err) {
    log('ERROR', '[' + (err.stage || 'unknown') + '] ' + err.message);
    return Result.fail({ flow: 'pack-apply', correlationId: correlationId, message: 'Pack was not applied: ' + err.message, error: err });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
};

/**
 * Replace every data row under the anchored header with rows. Clears values only (formats, validations and the
 * header stay). Columns are written by header name. Every written row gets a fresh id in the primary-key column:
 * the connector expects one on 4_fields, 5_lookups AND 4_complex_validations, and PrimaryKey.backfill does not
 * cover the rules tab. Text columns are set to plain-text format first, so a code like "1" is not turned into the
 * number 1 by setValues.
 */
Packs._writeTable = function(sheet, anchors, headers, rows) {
  if (!sheet) throw new Error('Sheet missing for headers ' + headers[0]);
  var data = sheet.getDataRange().getValues();
  var loc = Packs._locate(data, anchors, headers);
  if (!loc) throw new Error('Could not find the header row (' + anchors.join(' / ') + ') on ' + sheet.getName());
  var first = loc.headerRow + 2;                                  // 1-based row after the header
  var last = sheet.getLastRow();
  var width = sheet.getLastColumn();
  if (last >= first) sheet.getRange(first, 1, last - first + 1, width).clearContent();
  if (!rows.length) return { rows: 0, firstRow: first };
  var grid = rows.map(function(row) { return Packs._line(row, headers, loc, width, true); });
  Packs._textFormat(sheet, first, grid.length, headers, loc);
  sheet.getRange(first, 1, grid.length, width).setValues(grid);
  return { rows: grid.length, firstRow: first };
};

/** One sheet row from a { header: value } object; stamps a new id in the pk column when asked. */
Packs._line = function(row, headers, loc, width, withId) {
  var line = []; for (var c = 0; c < width; c++) line.push('');
  headers.forEach(function(h) {
    var c = loc.cols[h]; if (c === undefined) return;
    var v = row[h]; if (v === undefined || v === null) v = '';
    if (!PACK_BOOL_FIELDS[h] && typeof v !== 'boolean') v = String(v);   // codes and condition values stay text
    line[c] = v;
  });
  if (withId && loc.pkCol >= 0 && loc.pkCol < width) line[loc.pkCol] = Utilities.getUuid();
  return line;
};

/** Plain-text number format on every non-boolean header column of the rows about to be written. */
Packs._textFormat = function(sheet, first, count, headers, loc) {
  headers.forEach(function(h) {
    var c = loc.cols[h];
    if (c === undefined || PACK_BOOL_FIELDS[h]) return;
    sheet.getRange(first, c + 1, count, 1).setNumberFormat('@');
  });
};

/**
 * Lookups are merged, not replaced. Existing rows whose Table name the pack carries are removed; every other
 * existing row is kept and compacted to the top; the pack's rows go after them. Returns { rows, firstRow, kept }.
 */
Packs._mergeLookups = function(sheet, rows) {
  if (!sheet) throw new Error('Lookups sheet missing.');
  var data = sheet.getDataRange().getValues();
  var loc = Packs._locate(data, ['_pk_lookup_table_', 'Table name'], PACK_LOOKUP_HEADERS);
  if (!loc) throw new Error('Could not find the header row (_pk_lookup_table_ / Table name) on ' + sheet.getName());
  var tcol = loc.cols['Table name'];
  var packTables = {}; rows.forEach(function(r) { packTables[String(r['Table name']).trim().toLowerCase()] = true; });
  var keep = [];
  for (var r = loc.headerRow + 1; r < data.length; r++) {
    var t = String(data[r][tcol] || '').trim();
    if (!t) continue;                                             // stray cells with no Table name are dropped
    if (!packTables[t.toLowerCase()]) keep.push(data[r]);
  }
  var first = loc.headerRow + 2, last = sheet.getLastRow(), width = sheet.getLastColumn();
  if (last >= first) sheet.getRange(first, 1, last - first + 1, width).clearContent();
  var grid = keep.map(function(row) { var line = row.slice(0, width); while (line.length < width) line.push(''); return line; });
  rows.forEach(function(row) { grid.push(Packs._line(row, PACK_LOOKUP_HEADERS, loc, width, true)); });
  if (rows.length) Packs._textFormat(sheet, first + keep.length, rows.length, PACK_LOOKUP_HEADERS, loc);
  if (grid.length) sheet.getRange(first, 1, grid.length, width).setValues(grid);
  return { rows: rows.length, firstRow: first + keep.length, kept: keep.length };
};

/** Add or update meta rows in _developer_settings: category 'meta', keys pack_id, pack_version, collection_mode, pack_applied_at. */
Packs._stamp = function(ss, stamps) {
  var sh = ss.getSheetByName('_developer_settings');
  if (!sh) throw new Error('_developer_settings is missing.');
  var data = sh.getDataRange().getValues();
  Object.keys(stamps).forEach(function(key) {
    for (var r = 0; r < data.length; r++) {
      if (data[r][1] === 'meta' && data[r][2] === key) { sh.getRange(r + 1, 4).setValue(stamps[key]); return; }
    }
    sh.appendRow(['', 'meta', key, stamps[key], 'Stamped by Packs.apply']);
  });
};

if (typeof module !== 'undefined') module.exports = { Packs: Packs, PACK_FIELD_HEADERS: PACK_FIELD_HEADERS, PACK_RULE_HEADERS: PACK_RULE_HEADERS, PACK_LOOKUP_HEADERS: PACK_LOOKUP_HEADERS, PACK_BOOL_FIELDS: PACK_BOOL_FIELDS };
