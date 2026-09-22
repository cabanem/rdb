/**
 * DescriptionParser.gs — reads the Description column of 4_fields, proposes config values,
 * and applies the ones you accept.
 *
 * Flow
 *   1. Scan   -> reads the config shape, runs the extractors (+ optional AI), writes a review tab.
 *   2. Review -> tick Accept on the rows you want. Edit "Proposed value" if you like.
 *   3. Apply  -> writes accepted rows into 4_fields / 5_lookups / 4_complex_validations,
 *                marks them applied, and logs to _script_logs.
 *
 * Nothing touches the config tabs until Apply. Apply never overwrites a filled cell unless
 * OVERWRITE_EXISTING is true (the one exception: Data cleaning flags are appended, not replaced).
 *
 * Lint rows: when a pasted VMS spec disagrees with a cell the analyst already filled (Required ticked
 * but the spec says Optional; Data type "date" but the spec says Character (4) with example 0214), the
 * review tab shows a CONTRADICTION / CHECK row with confidence "lint". They are never pre-ticked.
 * Accepting one is an explicit overwrite of that cell. Rows with no automatic fix are skipped by Apply.
 *
 * Shape discovery — no column letters or row numbers are hard-coded:
 *   - tab names come from _developer_settings (Category = sheets), with defaults as fallback
 *   - header rows are found by anchor text (_pk_fields_, _pk_rules_, Table name)
 *   - columns are found by header text
 *   - vocabularies (data types, formats, rule names, cleaning flags) come from _mapping
 *
 * Files: DescriptionParser.gs (this), Extractors.gs (the rules), AiAdapter.gs (optional), Tests.gs
 */

var DP_SETTINGS = {
  PROPOSALS_SHEET: '_description_proposals',
  MAPPING_SHEET: '_mapping',
  SETTINGS_SHEET: '_developer_settings',
  OVERWRITE_EXISTING: false,          // Apply skips cells that already hold a value  (Script Property DP_OVERWRITE_EXISTING)
  ACCEPT_BY_DEFAULT: ['high'],        // confidence levels pre-ticked on the review tab
  NEW_LOOKUP_PROJECT_SPECIFIC: true,  // "Project specific?" on lookup rows this tool creates
  AI_MODE: 'off',                     // 'off' | 'gaps' | 'all'                    (Script Property DP_AI_MODE)
  AI_BATCH_SIZE: 10                   // descriptions per Gemini call
};

var DP_SHEET_DEFAULTS = { fields: '4_fields', validations: '4_complex_validations', lookupTables: '5_lookups', logs: '_script_logs' };

var DP_SYMMETRIC_RULES = /^(at least one required|mutually exclusive|combined fields must be unique|must match|must not match)$/i;

var DP_REVIEW_HEADER = ['Accept', 'Status', 'Row', 'Field name', 'Target sheet', 'Target column',
                        'Proposed value', 'Current value', 'Confidence', 'Rule', 'Evidence', 'Note', 'Payload'];

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Menu. The item names (dpScan, dpApply, ...) must resolve in the project that owns the menu.
 * Same project: dpAddMenu(ui). From a shim over the library: define wrappers named dpScan etc. in the
 * shim, then call Lib.dpAddMenu(ui) — or nest it: existingMenu.addSubMenu(Lib.dpMenu(ui)).
 */
function dpMenu(ui) {
  return ui.createMenu('Description parser')
    .addItem('1. Scan descriptions', 'dpScan')
    .addItem('2. Apply accepted proposals', 'dpApply')
    .addSeparator()
    .addItem('Accept all high-confidence rows', 'dpAcceptHigh')
    .addItem('Clear proposals', 'dpClear')
    .addItem('Run extractor tests', 'dpRunTests');
}
function dpAddMenu(ui) { dpMenu(ui).addToUi(); }

/** If this project has no onOpen yet, rename this function to onOpen. */
function dpOnOpen() { dpAddMenu(SpreadsheetApp.getUi()); }

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * overrides: an object keyed like the Script Properties (DP_AI_MODE, DP_GCP_PROJECT, ...).
 * A library reads its own Script Properties, not the host's — so a shim passes its properties in here.
 */
function dpSettings_(overrides) {
  var p = PropertiesService.getScriptProperties().getProperties();
  Object.keys(overrides || {}).forEach(function (k) { if (/^DP_/.test(k)) p[k] = overrides[k]; });
  var s = {};
  Object.keys(DP_SETTINGS).forEach(function (k) { s[k] = DP_SETTINGS[k]; });
  if (p.DP_AI_MODE) s.AI_MODE = String(p.DP_AI_MODE).toLowerCase();
  if (p.DP_OVERWRITE_EXISTING) s.OVERWRITE_EXISTING = /^true$/i.test(p.DP_OVERWRITE_EXISTING);
  s.GCP_PROJECT  = p.DP_GCP_PROJECT || '';
  s.GCP_LOCATION = p.DP_GCP_LOCATION || 'global';
  s.GEMINI_MODEL = p.DP_GEMINI_MODEL || 'gemini-2.5-flash';
  return s;
}

// ---------------------------------------------------------------------------
// Shape discovery
// ---------------------------------------------------------------------------

/** Tab names from _developer_settings (Category = sheets), falling back to defaults. */
function dpSheetNames_(ss) {
  var names = {};
  Object.keys(DP_SHEET_DEFAULTS).forEach(function (k) { names[k] = DP_SHEET_DEFAULTS[k]; });
  var sh = ss.getSheetByName(DP_SETTINGS.SETTINGS_SHEET);
  if (!sh) return names;
  var values = sh.getDataRange().getValues();
  var hdr = -1, cCat = -1, cKey = -1, cVal = -1;
  for (var r = 0; r < values.length && hdr < 0; r++) {
    var row = values[r].map(function (c) { return String(c).trim(); });
    cCat = row.indexOf('Category'); cKey = row.indexOf('Key'); cVal = row.indexOf('Value');
    if (cCat >= 0 && cKey >= 0 && cVal >= 0) hdr = r;
  }
  if (hdr < 0) return names;
  for (var i = hdr + 1; i < values.length; i++) {
    if (String(values[i][cCat]).trim() !== 'sheets') continue;
    var key = String(values[i][cKey]).trim(), val = String(values[i][cVal]).trim();
    if (key && val && names.hasOwnProperty(key)) names[key] = val;
  }
  return names;
}

/**
 * Read a table whose header row contains `anchor`. Rows are kept only when `keyHeader` is non-empty.
 * Returns { sheet, headerRow (1-based), header[], cols {headerText: 0-based index}, rows [{row (1-based), v {headerText: value}}] }
 */
function dpReadTable_(sheet, anchor, keyHeader) {
  var values = sheet.getDataRange().getValues();
  var headerIdx = -1;
  for (var r = 0; r < values.length && headerIdx < 0; r++)
    if (values[r].some(function (c) { return String(c).trim() === anchor; })) headerIdx = r;
  if (headerIdx < 0) throw new Error('Could not find the header row in "' + sheet.getName() + '" (looked for a cell equal to "' + anchor + '").');

  var header = values[headerIdx].map(function (c) { return String(c).trim(); });
  var cols = {};
  header.forEach(function (h, i) { if (h && cols[h] == null) cols[h] = i; });
  if (cols[keyHeader] == null) throw new Error('Column "' + keyHeader + '" not found in "' + sheet.getName() + '".');

  // primary-key column: a "_pk_..." header, or (5_lookups) the header-less column right after Table name
  var pkKey = Object.keys(cols).filter(function (h) { return /^_pk_/.test(h); })[0] || '';
  if (!pkKey && cols['Table name'] != null && !header[cols['Table name'] + 1]) { pkKey = '_pk_'; cols[pkKey] = cols['Table name'] + 1; }

  var rows = [];
  for (var i = headerIdx + 1; i < values.length; i++) {
    if (String(values[i][cols[keyHeader]]).trim() === '') continue;
    var v = {};
    header.forEach(function (h, j) { if (h) v[h] = values[i][j]; });
    rows.push({ row: i + 1, v: v });
  }
  return { sheet: sheet, headerRow: headerIdx + 1, header: header, cols: cols, pkKey: pkKey, rows: rows };
}

/** Existing rows store booleans either as real TRUE/FALSE or as the text "True"/"False". Match whatever is there. */
function dpBoolLike_(table, header, value) {
  var sample = table.rows.length ? table.rows[0].v[header] : true;
  if (typeof sample === 'string' && /^(true|false)$/i.test(sample))
    return sample === sample.toUpperCase() ? String(value).toUpperCase() : value ? 'True' : 'False';
  return value;
}

/** Controlled vocabularies from _mapping (row 1 = list names). Falls back to DP_VOCAB_DEFAULT. */
function dpVocab_(ss) {
  var sh = ss.getSheetByName(DP_SETTINGS.MAPPING_SHEET);
  if (!sh) return DP_VOCAB_DEFAULT;
  var values = sh.getDataRange().getValues();
  var head = values[0].map(function (c) { return String(c).trim(); });
  var column = function (name) {
    var i = head.indexOf(name);
    if (i < 0) return null;
    var out = [];
    for (var r = 1; r < values.length; r++) { var c = String(values[r][i]).trim(); if (!c) break; out.push(c); }
    return out;
  };
  var rules = column('rule_name'), types = column('type');
  return {
    dataTypes:   column('data_type') || DP_VOCAB_DEFAULT.dataTypes,
    dataFormats: dpUnique_(column('data_format') || DP_VOCAB_DEFAULT.dataFormats),
    rules:       rules ? rules.filter(function (r, i) { return !types || /complex/i.test(types[i] || ''); }) : DP_VOCAB_DEFAULT.rules,
    flags:       column('cleaning_flags') || DP_VOCAB_DEFAULT.flags
  };
}

function dpShape_(ss) {
  var names = dpSheetNames_(ss);
  var need = function (key) {
    var sh = ss.getSheetByName(names[key]);
    if (!sh) throw new Error('Sheet "' + names[key] + '" not found (settings key "' + key + '").');
    return sh;
  };
  return {
    names:   names,
    fields:  dpReadTable_(need('fields'), '_pk_fields_', DP_COL.NAME),
    rules:   dpReadTable_(need('validations'), '_pk_rules_', 'Target field'),
    lookups: dpReadTable_(need('lookupTables'), 'Table name', 'Table name'),
    vocab:   dpVocab_(ss)
  };
}

/** Shared context for the extractors: every field name, each field's lookup, every lookup table's values. */
function dpContext_(shape) {
  var fieldNames = [], fieldsByName = {}, lookupTables = {};
  shape.fields.rows.forEach(function (r) {
    var n = String(r.v[DP_COL.NAME]).trim();
    fieldNames.push(n);
    fieldsByName[n] = { lookup: String(r.v[DP_COL.LOOKUP] || '').trim(), type: String(r.v[DP_COL.TYPE] || '').trim() };
  });
  shape.lookups.rows.forEach(function (r) {
    var t = String(r.v['Table name']).trim();
    var e = lookupTables[t] || (lookupTables[t] = { values: [], codes: [] });
    e.values.push(String(r.v['Value'] == null ? '' : r.v['Value']).trim());
    e.codes.push(String(r.v['Code'] == null ? '' : r.v['Code']).trim());
  });
  return { fieldNames: fieldNames, fieldsByName: fieldsByName, lookupTables: lookupTables, vocab: shape.vocab };
}

function dpRowContext_(base, r) {
  var ctx = {};
  Object.keys(base).forEach(function (k) { ctx[k] = base[k]; });
  ctx.fieldName  = String(r.v[DP_COL.NAME] || '').trim();
  ctx.dataType   = String(r.v[DP_COL.TYPE] || '').trim();
  ctx.dataFormat = String(r.v[DP_COL.FORMAT] || '').trim();
  ctx.lookupName = String(r.v[DP_COL.LOOKUP] || '').trim();
  var req = r.v[DP_COL.REQUIRED];
  ctx.required = req === true || /^true$/i.test(String(req == null ? '' : req).trim());   // false covers blank and FALSE
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. Scan
// ---------------------------------------------------------------------------

function dpScan(overrides) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var corr = Utilities.getUuid();
  var settings = dpSettings_(overrides);
  var shape = dpShape_(ss);
  var base = dpContext_(shape);

  var perRow = [], aiQueue = [];
  shape.fields.rows.forEach(function (r) {
    var desc = String(r.v[DP_COL.DESC] || '').trim();
    if (!desc) return;
    var ctx = dpRowContext_(base, r);
    var entry = { r: r, ctx: ctx, desc: desc, proposals: dpExtract(desc, ctx) };
    perRow.push(entry);
    if (settings.AI_MODE === 'all' || (settings.AI_MODE === 'gaps' && !entry.proposals.length && dpHasRuleSignal(desc)))
      aiQueue.push(entry);
  });

  var aiNote = '';
  if (aiQueue.length) {
    try {
      dpAiPropose(aiQueue, settings);                    // appends AI proposals onto each entry.proposals
      aiNote = ', AI consulted for ' + aiQueue.length;
    } catch (e) {
      aiNote = ', AI skipped (' + e.message + ')';
      dpLog_(ss, shape.names, 'WARNING', 'AI call failed: ' + e.message, corr);
    }
  }

  // A symmetric rule ("At least one required", "Mutually exclusive", …) read from both fields' specs is one rule.
  // Keep the first, downgrade the mirror so the reviewer accepts only one.
  var seenPairs = {};
  perRow.forEach(function (entry) {
    entry.proposals.forEach(function (p) {
      if (p.sheet !== 'rules' || !DP_SYMMETRIC_RULES.test(p.column)) return;
      var a = dpNorm_(entry.ctx.fieldName), b = dpNorm_(p.value.conditionField);
      var key = dpNorm_(p.column) + '|' + [a, b].sort().join('|');
      if (seenPairs[key]) { p.confidence = 'medium'; p.note = dpJoinNote_(p.note, 'same rule as the one proposed on "' + seenPairs[key] + '" — accept only one of the two'); }
      else seenPairs[key] = entry.ctx.fieldName;
    });
  });

  var review = [];
  perRow.forEach(function (entry) {
    dpMerge_(entry.proposals).forEach(function (p) {
      var line = dpReviewLine_(p, entry, shape, settings);
      if (line) review.push(line);
    });
  });

  dpWriteReview_(ss, review, settings);
  var msg = 'Scanned ' + perRow.length + ' descriptions, ' + review.length + ' proposals' + aiNote;
  dpLog_(ss, shape.names, 'SUCCESS', msg, corr);
  SpreadsheetApp.getActiveSpreadsheet().toast(msg + '. Review them on ' + settings.PROPOSALS_SHEET + '.', 'Description parser', 8);
}

/** Turn one proposal into one review-tab row. Returns null for no-ops (already set, already exists). */
function dpReviewLine_(p, entry, shape, settings) {
  var r = entry.r, names = shape.names;
  var target = '', column = '', display = '', current = '', note = p.note || '';

  if (p.lint) {                                                   // the spec disagrees with a filled cell
    current = r.v[p.column]; if (current == null) current = '';
    if (p.value != null) { var lerr = dpValidateFieldValue(p, shape.vocab); if (lerr) { note = dpJoinNote_(note, 'REJECTED: ' + lerr); p.value = null; } }
    target = names.fields; column = p.column;
    display = p.value == null ? '(no automatic fix — edit the cell by hand)' : p.value;
    note = (p.severity === 'error' ? 'CONTRADICTION: ' : 'CHECK: ') + note + (p.value == null ? '' : ' Accepting this row overwrites the cell.');
    var lpayload = { sheet: 'fields', column: p.column, value: p.value, row: r.row, fieldName: entry.ctx.fieldName, lint: true };
    return [false, 'pending', r.row, entry.ctx.fieldName, target, column, display, current, 'lint', p.rule, p.evidence, note, JSON.stringify(lpayload)];
  }

  if (p.sheet === 'fields') {
    var err = dpValidateFieldValue(p, shape.vocab);
    if (err) { note = dpJoinNote_(note, 'REJECTED: ' + err); p.confidence = 'low'; }
    current = r.v[p.column];
    if (current == null) current = '';
    if (typeof p.value === 'boolean' ? current === p.value : String(current).trim() === String(p.value)) return null;
    if (String(current).trim() !== '' && current !== false && p.column !== DP_COL.FLAGS)
      note = dpJoinNote_(note, 'cell already has a value' + (settings.OVERWRITE_EXISTING ? '' : ' — Apply will skip it'));
    target = names.fields; column = p.column; display = p.value;
  } else if (p.sheet === 'lookups') {
    if (entry.ctx.lookupTables[p.value]) return null;
    target = names.lookupTables; column = 'table: ' + p.value; display = (p.values || []).join(' | ');
  } else if (p.sheet === 'rules') {
    var dup = shape.rules.rows.some(function (x) {
      return dpNorm_(x.v['Target field']) === dpNorm_(entry.ctx.fieldName) && dpNorm_(x.v['Rule or action']) === dpNorm_(p.column)
          && dpNorm_(x.v['Condition field']) === dpNorm_(p.value.conditionField) && dpNorm_(x.v['Condition value']) === dpNorm_(p.value.conditionValue);
    });
    if (dup) return null;
    if (shape.vocab.rules.map(dpNorm_).indexOf(dpNorm_(p.column)) < 0) { note = dpJoinNote_(note, 'REJECTED: unknown rule "' + p.column + '"'); p.confidence = 'low'; }
    target = names.validations; column = p.column;
    display = (p.value.conditionField || '?') + ' = ' + (p.value.conditionValue === '' ? '(blank)' : p.value.conditionValue);
  }

  var accept = settings.ACCEPT_BY_DEFAULT.indexOf(p.confidence) >= 0 && !/REJECTED|already has a value/.test(note);
  var payload = { sheet: p.sheet, column: p.column, value: p.value, values: p.values, row: r.row, fieldName: entry.ctx.fieldName };
  return [accept, 'pending', r.row, entry.ctx.fieldName, target, column, display, current, p.confidence, p.rule, p.evidence, note, JSON.stringify(payload)];
}

function dpWriteReview_(ss, lines, settings) {
  var sh = ss.getSheetByName(settings.PROPOSALS_SHEET) || ss.insertSheet(settings.PROPOSALS_SHEET);
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();   // old checkboxes
  sh.getRange(1, 1, 1, DP_REVIEW_HEADER.length).setValues([DP_REVIEW_HEADER]).setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  if (lines.length) {
    sh.getRange(2, 1, lines.length, DP_REVIEW_HEADER.length).setValues(lines);
    sh.getRange(2, 1, lines.length, 1).insertCheckboxes();
    sh.getRange(2, 1, lines.length, 1).setValues(lines.map(function (l) { return [l[0]]; }));
    sh.getRange(2, 13, lines.length, 1).setFontColor('#bbbbbb').setFontSize(7);     // Payload: keep, but out of the way
  }
  [60, 80, 50, 180, 150, 180, 240, 140, 90, 110, 260, 300, 60].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(1, 7, Math.max(lines.length, 1) + 1, 1).setWrap(true);
  sh.getRange(1, 11, Math.max(lines.length, 1) + 1, 2).setWrap(true);
  ss.setActiveSheet(sh);
}

function dpAcceptHigh(overrides) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(dpSettings_(overrides).PROPOSALS_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var n = sh.getLastRow() - 1;
  var conf = sh.getRange(2, 9, n, 1).getValues();
  var status = sh.getRange(2, 2, n, 1).getValues();
  var notes = sh.getRange(2, 12, n, 1).getValues();
  sh.getRange(2, 1, n, 1).setValues(conf.map(function (c, i) {
    return [c[0] === 'high' && status[i][0] === 'pending' && !/REJECTED/.test(notes[i][0])];
  }));
}

function dpClear(overrides) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(dpSettings_(overrides).PROPOSALS_SHEET);
  if (sh) ss.deleteSheet(sh);
}

// ---------------------------------------------------------------------------
// 2. Apply
// ---------------------------------------------------------------------------

function dpApply(overrides) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var corr = Utilities.getUuid();
  var settings = dpSettings_(overrides);
  var sh = ss.getSheetByName(settings.PROPOSALS_SHEET);
  if (!sh || sh.getLastRow() < 2) throw new Error('No proposals to apply. Run "Scan descriptions" first.');
  var shape = dpShape_(ss);
  var ctx = dpContext_(shape);

  var data = sh.getDataRange().getValues();
  var col = {};
  data[0].forEach(function (h, i) { col[h] = i; });
  var status = data.map(function (row) { return [row[col.Status], row[col.Note]]; });
  var lookupAppends = {}, ruleAppends = [];
  var counts = { applied: 0, skipped: 0, failed: 0 };
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');

  var finish = function (i, st, why) {
    status[i] = [st, dpJoinNote_(String(data[i][col.Note] || ''), st + ' ' + stamp + (why ? ' — ' + why : ''))];
    counts[st === 'applied' ? 'applied' : st === 'failed' ? 'failed' : 'skipped']++;
  };

  for (var i = 1; i < data.length; i++) {
    if (data[i][col.Accept] !== true || data[i][col.Status] !== 'pending') continue;
    try {
      var p = JSON.parse(data[i][col.Payload]);
      var edited = data[i][col['Proposed value']];             // the reviewer may have edited the display value

      if (p.sheet === 'fields') {
        var target = shape.fields.rows.filter(function (x) { return x.row === p.row; })[0];
        if (!target || dpNorm_(target.v[DP_COL.NAME]) !== dpNorm_(p.fieldName)) { finish(i, 'skipped', 'row ' + p.row + ' no longer holds "' + p.fieldName + '" — rescan'); continue; }
        if (p.lint && p.value == null) { finish(i, 'skipped', 'no automatic fix — edit the cell by hand'); continue; }
        if (typeof p.value !== 'boolean' && String(edited).trim() !== String(p.value)) p.value = String(edited).trim();
        var err = dpValidateFieldValue(p, shape.vocab);
        if (err) { finish(i, 'failed', err); continue; }
        var c = shape.fields.cols[p.column];
        if (c == null) { finish(i, 'failed', 'column "' + p.column + '" not found'); continue; }
        var cur = target.v[p.column];
        var curStr = cur == null ? '' : String(cur).trim();
        if (p.column === DP_COL.FLAGS && curStr) {
          if (curStr.split(/\s*,\s*/).indexOf(p.value) >= 0) { finish(i, 'skipped', 'flag already present'); continue; }
          p.value = curStr + ', ' + p.value;
        } else if (curStr && cur !== false && !settings.OVERWRITE_EXISTING && !p.lint) { finish(i, 'skipped', 'cell already has a value'); continue; }   // an accepted lint row is an explicit overwrite
        shape.fields.sheet.getRange(p.row, c + 1).setValue(p.value);
        target.v[p.column] = p.value;
        finish(i, 'applied');

      } else if (p.sheet === 'lookups') {
        if (ctx.lookupTables[p.value]) { finish(i, 'skipped', 'table already exists'); continue; }
        var vals = String(edited).split(/\s*\|\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (vals.length < 2) { finish(i, 'failed', 'need at least two values'); continue; }
        lookupAppends[p.value] = { values: vals, i: i };

      } else if (p.sheet === 'rules') {
        var m = String(edited).match(/^(.*?)\s*=\s*(.*)$/);
        var cf = m ? m[1].trim() : p.value.conditionField, cv = m ? m[2].trim().replace(/^\(blank\)$/, '') : p.value.conditionValue;
        if (ctx.fieldNames.indexOf(cf) < 0) { finish(i, 'failed', 'condition field "' + cf + '" is not a field in ' + shape.names.fields); continue; }
        ruleAppends.push({ i: i, target: p.fieldName, rule: p.column, cf: cf, cv: cv });
      }
    } catch (e) { finish(i, 'failed', String(e.message || e)); }
  }

  // append new lookup tables (grouped by table name, as the tab expects)
  var lk = shape.lookups, lkRows = [];
  Object.keys(lookupAppends).forEach(function (name) {
    lookupAppends[name].values.forEach(function (v) {
      var row = new Array(lk.header.length).fill('');
      var put = function (h, val) { if (lk.cols[h] != null) row[lk.cols[h]] = val; };
      put('Table name', name); put(lk.pkKey, Utilities.getUuid()); put('Code', v); put('Value', v);
      put('Record active?', dpBoolLike_(lk, 'Record active?', true));
      put('Project specific?', dpBoolLike_(lk, 'Project specific?', settings.NEW_LOOKUP_PROJECT_SPECIFIC));
      lkRows.push(row);
    });
    finish(lookupAppends[name].i, 'applied');
  });
  if (lkRows.length) dpAppendRows_(lk, lkRows);

  // append new complex rules
  var rl = shape.rules, rlRows = [];
  ruleAppends.forEach(function (a) {
    var row = new Array(rl.header.length).fill('');
    var put = function (h, val) { if (rl.cols[h] != null) row[rl.cols[h]] = val; };
    put(rl.pkKey, Utilities.getUuid()); put('Target field', a.target); put('Rule or action', a.rule);
    put('Condition field', a.cf); put('Condition value', a.cv);
    rlRows.push(row);
    finish(a.i, 'applied');
  });
  if (rlRows.length) dpAppendRows_(rl, rlRows);

  sh.getRange(1, col.Status + 1, status.length, 1).setValues(status.map(function (s) { return [s[0]]; }));
  sh.getRange(1, col.Note + 1, status.length, 1).setValues(status.map(function (s) { return [s[1]]; }));
  var msg = 'Applied ' + counts.applied + ', skipped ' + counts.skipped + ', failed ' + counts.failed;
  dpLog_(ss, shape.names, counts.failed ? 'WARNING' : 'SUCCESS', msg, corr);
  ss.toast(msg + '.', 'Description parser', 8);
}

/** Append rows after the last data row of a table, growing the sheet if needed. Skips columns whose header cell is a formula. */
function dpAppendRows_(table, rows) {
  var last = table.rows.length ? table.rows[table.rows.length - 1].row : table.headerRow;
  var start = last + 1, sheet = table.sheet;
  if (start + rows.length - 1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), start + rows.length - 1 - sheet.getMaxRows());
  var width = table.header.length;
  var formulas = sheet.getRange(start, 1, 1, width).getFormulas()[0];   // array formulas above may spill into these cells
  for (var j = 0; j < width; j++) {
    if (formulas[j]) continue;
    var column = rows.map(function (row) { return [row[j]]; });
    if (column.every(function (c) { return c[0] === ''; })) continue;
    sheet.getRange(start, j + 1, rows.length, 1).setValues(column);
  }
}

// ---------------------------------------------------------------------------
// Logging — same shape as the existing _script_logs tab
// ---------------------------------------------------------------------------

function dpLog_(ss, names, status, message, corr) {
  try {
    var sh = ss.getSheetByName(names.logs);
    if (!sh) return;
    var user = '';
    try { user = Session.getActiveUser().getEmail(); } catch (e) {}
    sh.appendRow([new Date(), status, user, '[description-parser] ' + message, corr]);
  } catch (e) { /* logging must never break the run */ }
}
