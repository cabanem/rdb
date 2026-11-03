/**
 * @file pipeline/ReviewSheet.gs — the per-contract review Sheet: its layout, how it is created, read back and
 * marked, and what the Approved column looks like when the reviewer opens it: dropdowns on picklists,
 * checkboxes on booleans, date pickers on dates, and a highlight wherever the model's text did not fit.
 *
 * @summary planApprovedCells_() is pure: given the schema and the model's parsed output it decides, per row, what to
 * seed into Approved, whether to flag it, and which validation rule to attach. applyApprovedPlan_() is the thin
 * Sheets layer that carries the plan out in a handful of batch calls. createReviewSheet_() calls both.
 *
 * @description Design notes:
 *   1. Validation is data, not code. A dropdown is a property of the cell, so the review sheet stays a script-free
 *      artifact (the standing invariant) while still steering the reviewer toward valid values.
 *   2. Seed through the same matcher the gate uses (Gate.gs). A picklist cell is seeded with the option's LABEL
 *      when the model's text matches an option by label or value; otherwise it is left blank and highlighted. The
 *      Extracted column still shows what the model said, so the blank is a signal, not a loss. Booleans seed as
 *      ticked/unticked; dates seed as real Dates. Everything else keeps the model's text, highlighted when the gate
 *      would reject it (too long, not a number, not a link...), with the gate's own message as the cell note.
 *   3. Write values first, then validation. Apps Script throws if a strict rule is already on a cell when an
 *      invalid value is written; seeding blank-or-valid and attaching rules afterwards sidesteps that entirely.
 *   4. Single-select picklists are strict (input rejected); multipicklists are advisory (warning triangle), because
 *      Apps Script cannot create a multi-select dropdown — the arrow shows the vocabulary, the reviewer types
 *      "A; B", and the gate enforces. Dependent picklists cannot cascade without code and get the full list.
 *   5. {} schema -> no plan. Every cell is seeded with the model's text, no rules, no highlights: today's sheet.
 *   6. Rows have roles (Config output_fields markers). A `[manual]` row is the reviewer's: its Extracted cell is
 *      blank and shaded because there was nothing to extract. An `[info]` row is the model's but goes nowhere: a
 *      note says so. The Opportunity row is a `[manual]` row that may also carry a dropdown of suggestions fetched
 *      from Workato with the extracted account name; each option ends in the Opportunity Id in brackets, so the
 *      gate reads the Id straight out of the chosen text and no label -> Id map has to live in the sheet. The
 *      dropdown is advisory (allow invalid) so a pasted Id or URL is still accepted.
 *   7. Required rows (Gate.gs requiredLabels_) get a marker in the Field column and, when the seed is blank, the
 *      same highlight as a misfit — the reviewer sees what blocks the push before ticking Approved.
 *   8. A "not found" phrase from the model (Config blank_phrases) stays in Extracted, where it is honest, and
 *      seeds Approved as blank, where it would otherwise be sent to Salesforce as text and rejected.
 *   9. Gate failures land on the cells. markCellErrors_ turns each failing Approved cell red and prepends the
 *      gate's line to its note; clearCellErrors_ undoes exactly that (and nothing else) on the next attempt, so a
 *      fixed cell stops being red without losing its options note. Last error keeps the headline list.
 *
 * WIRING
 *   processIngestion():  const schema = loadSchema_();   -> extractOneFile_(file, cfg, pending, schema)
 *   createReviewSheet_(parsedData, file, sources, cfg, pendingFolder, schema):
 *       const plan = planApprovedCells_(cfg, schema, cfg.output_fields, parsedData);
 *       rows = plan.map(p => [p.label, p.extracted, p.seed]);  ... setValues(rows) ...
 *       applyApprovedPlan_(sheet, headerRow + 1, plan);
 */

// --- LAYOUT --------------------------------------------------------------------------------------
/** @const {string}  Name of the review tab within each review spreadsheet.*/
const REVIEW_SHEET_TAB = 'Review';

/**
 * Review-sheet metadata labels (column A). Reads are label-scanned, not by row
 * index, so light hand-edits to the sheet don't break the approval reader.
 * @const {Object.<string,string>}
 */
const META = {
  ORIGINAL: 'Original file',
  SOURCE_ID: 'Source file ID',
  SOURCE_NAME: 'Source file name',
  CORRELATION: 'Correlation ID',
  EXTRACTED: 'Extracted at',
  MODEL: 'Model',
  STATUS: 'Status',
  APPROVED: 'Approved?',
  PUSHED_AT: 'Pushed at',
  CANCEL: 'Cancel?',
  CANCELLED_AT: 'Cancelled at',
  ERROR: 'Last error',
  SOURCES: 'Grounding sources'
};

/** @const {string[]} Header row of the field grid. */
const GRID_HEADER = ['Field', 'Extracted', 'Approved'];

// --- CREATE --------------------------------------------------------------------------------------
/**
 * Build the per-contract review Sheet in `pending`. Fields are written in CONFIG
 * order (not parse order) so the reviewer always sees a stable layout. A
 * correlation_id is minted here and travels with the contract through the push.
 * The Approved column is planned from the schema (ReviewSheet.gs): seeded with the
 * matching option, checkbox state or Date where the model's text fits, blank and
 * highlighted where it does not, with dropdowns/pickers attached after the values.
 * @param {Object.<string,string>} parsedData Extracted field values.
 * @param {GoogleAppsScript.Drive.File} file Source contract.
 * @param {string} sources Grounding sources (may be '').
 * @param {Config} cfg
 * @param {GoogleAppsScript.Drive.Folder} pendingFolder
 * @param {Schema} [schema] Cached field schema; {} = no dropdowns, raw seeding.
 * @return {ReviewSheetRef}
 * @private
 */
function createReviewSheet_(parsedData, file, sources, cfg, pendingFolder, schema) {
  const ss = SpreadsheetApp.create('Contract Review: ' + file.getName());
  const sheet = ss.getSheets()[0].setName(REVIEW_SHEET_TAB);

  const corr = Utilities.getUuid();
  const meta = [
    [META.ORIGINAL, '=HYPERLINK("' + file.getUrl() + '","' + file.getName().replace(/"/g, "'") + '")'],
    [META.SOURCE_ID, file.getId()],
    [META.SOURCE_NAME, file.getName()],
    [META.CORRELATION, corr],
    [META.EXTRACTED, new Date().toISOString()],
    [META.MODEL, cfg.model || 'gemini-2.5-pro'],
    [META.STATUS, 'Pending Review'],
    [META.APPROVED, false],
    [META.CANCEL, false]
  ];
  meta.forEach(function (pair, i) {
    sheet.getRange(i + 1, 1).setValue(pair[0]).setFontWeight('bold');
    const cell = sheet.getRange(i + 1, 2);
    if (pair[0] === META.ORIGINAL) cell.setFormula(pair[1]);
    else cell.setValue(pair[1]);
  });
  // Make "Approved?" and "Cancel?" real checkboxes, found by label so reordering the block cannot break them.
  [META.APPROVED, META.CANCEL].forEach(function (label) {
    const i = meta.findIndex(function (pair) { return pair[0] === label; });
    sheet.getRange(i + 1, 2).insertCheckboxes();
    if (label === META.CANCEL) {
      sheet.getRange(i + 1, 2).setNote('Tick this instead of Approved? to withdraw the contract. Nothing is sent, and the sheet moves to the adjacent Cancelled folder.');
    }
  });

  // Field grid: Field | Extracted | Approved. Extracted is the model's text verbatim; Approved is seeded by the plan.
  const headerRow = meta.length + 2;
  sheet.getRange(headerRow, 1, 1, 3).setValues([GRID_HEADER]).setFontWeight('bold');
  const candidates = fetchOpportunityCandidates_(cfg, corr,
    cfg.opportunity_search_label ? parsedData[cfg.opportunity_search_label] : '');   // [] when off or unavailable
  const plan = planApprovedCells_(cfg, schema || {}, cfg.output_fields, parsedData, candidates);
  const rows = plan.map(function (p) { return [p.label, p.extracted, p.seed]; });
  if (rows.length) {
    sheet.getRange(headerRow + 1, 1, rows.length, 3).setValues(rows);
    applyApprovedPlan_(sheet, headerRow + 1, plan);        // values first, then rules (strict rules reject invalid writes)
  }

  // Sources block below the grid (provenance, read-only by convention).
  const srcRow = headerRow + rows.length + 2;
  sheet.getRange(srcRow, 1).setValue(META.SOURCES).setFontWeight('bold');
  sheet.getRange(srcRow, 2).setValue(sources || '(none)');

  sheet.setColumnWidth(1, 220).setColumnWidth(2, 420).setColumnWidth(3, 420);
  sheet.setFrozenRows(headerRow);
  SpreadsheetApp.flush();

  moveFile_(DriveApp.getFileById(ss.getId()), pendingFolder);
  return { id: ss.getId(), url: ss.getUrl(), correlationId: corr };
}

// --- READ BACK -----------------------------------------------------------------------------------
/**
 * Read approval state and the human-approved values from a review sheet.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The review spreadsheet.
 * @return {Approval}
 * @private
 */
function readApproval_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];

  const approved = readMeta_(sheet, META.APPROVED) === true;
  const cancelled = readMeta_(sheet, META.CANCEL) === true;
  const corr = readMeta_(sheet, META.CORRELATION);
  const fileId = readMeta_(sheet, META.SOURCE_ID);
  const fileName = readMeta_(sheet, META.SOURCE_NAME);
  const model = readMeta_(sheet, META.MODEL);
  const extAt = readMeta_(sheet, META.EXTRACTED);
  const status = str_(readMeta_(sheet, META.STATUS));
  const lastError = str_(readMeta_(sheet, META.ERROR));

  // Locate the Field/Extracted/Approved grid by its header.
  const values = sheet.getDataRange().getValues();
  let h = -1;
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim() === GRID_HEADER[0] &&
      String(values[r][1]).trim() === GRID_HEADER[1]) { h = r; break; }
  }
  const approvedFields = {};
  const extractedFields = {};
  if (h !== -1) {
    for (let r = h + 1; r < values.length; r++) {
      const label = String(values[r][0]).trim();
      if (!label || sameLabel_(label, META.SOURCES)) break;   // grid ends
      extractedFields[label] = values[r][1];
      approvedFields[label] = values[r][2];
    }
  }
  return {
    approved: approved, correlationId: corr, fileId: fileId, fileName: fileName,
    cancelled: cancelled,
    model: model, extractedAt: extAt, status: status, lastError: lastError,
    fields: approvedFields, extracted: extractedFields
  };
}

/**
 * What processApprovals does with a pending sheet.
 */
function nextAction_(approval) {
  if (approval.cancelled) return 'cancel';
  if (approval.approved) return 'push';
  return 'wait';
}

/**
 * Find a metadata value by its label in column A (first 30 rows).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} label
 * @return {*} The adjacent column-B value, or '' if not found.
 * @private
 */
function readMeta_(sheet, label) {
  const col = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 30), 2).getValues();
  for (let i = 0; i < col.length; i++) {
    if (sameLabel_(col[i][0], label)) return col[i][1];
  }
  return '';
}

/**
 * Label equality for the review sheet: trimmed and case-insensitive, so sheets created before the labels were
 * sentence-cased ("Source File ID") still read under the current constants ("Source file ID").
 * @param {*} a
 * @param {*} b
 * @return {boolean}
 * @private
 */
function sameLabel_(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}

// --- MARK ----------------------------------------------------------------------------------------
/**
 * Mark a review sheet as pushed (status + timestamp).
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @private
 */
function markPushed_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Pushed');
  setMeta_(sheet, META.PUSHED_AT, new Date().toISOString());
}

function markCancelled_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Cancelled');
  setMeta_(sheet, META.CANCELLED_AT, new Date().toISOString());
}

/**
 * A sheet un-cancelled and moved back to Pending gets its Status word back.
 */
function markPending_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Pending Review');
}

/**
 * Mark a review sheet as errored (status + truncated message).
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} msg
 * @private
 */
function markError_(ss, msg) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Error');
  setMeta_(sheet, META.ERROR, String(msg).slice(0, REVIEW_ERROR_MAX)).setWrap(true).setVerticalAlignment('top');
}

/** @const {number} Characters kept in the Last error cell; Triggers.gs compares against the same cut. */
const REVIEW_ERROR_MAX = 2000;

/** @const {string} Background of an Approved cell the gate rejected. */
const REVIEW_ERROR_COLOR = '#f8d7da';

/** @const {string} First characters of a note line written by markCellErrors_; clearCellErrors_ keys on it. */
const REVIEW_ERROR_PREFIX = '⚠ ';

/**
 * Where the Field/Extracted/Approved grid sits: 1-based row of each label, plus the span, so callers can read
 * and write the Approved column in one range. Same header scan as readApproval_. Empty object when no grid.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {{rows:Object.<string,number>, first:number, count:number}}
 * @private
 */
function gridRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  const out = { rows: {}, first: 0, count: 0 };
  let h = -1;
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim() === GRID_HEADER[0] && String(values[r][1]).trim() === GRID_HEADER[1]) { h = r; break; }
  }
  if (h === -1) return out;
  for (let r = h + 1; r < values.length; r++) {
    const label = String(values[r][0]).trim();
    if (!label || sameLabel_(label, META.SOURCES)) break;
    out.rows[label] = r + 1;
    if (!out.first) out.first = r + 1;
    out.count++;
  }
  return out;
}

/**
 * Put the gate's verdicts on the cells: each "Label: message" line turns that label's Approved cell red and
 * prepends the message to the cell's note (the options note stays underneath). Previous marks are cleared first,
 * so the sheet always shows the latest attempt only. Lines whose label is not on the grid are ignored.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string[]} errors GateReport.errors
 * @private
 */
function markCellErrors_(ss, errors) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  const grid = gridRows_(sheet);
  if (!grid.count) return;
  clearCellErrors_(ss);
  const byLabel = splitGateErrors_(errors);
  Object.keys(byLabel).forEach(function (label) {
    const row = grid.rows[label];
    if (!row) return;
    const cell = sheet.getRange(row, 3);
    const existing = str_(cell.getNote());
    cell.setBackground(REVIEW_ERROR_COLOR);
    cell.setNote(REVIEW_ERROR_PREFIX + byLabel[label].join('\n' + REVIEW_ERROR_PREFIX) + (existing ? '\n\n' + existing : ''));
  });
}

/**
 * Undo markCellErrors_: Approved cells carrying the error colour go back to no background, and the ⚠ lines come
 * off the top of their notes. Cells the gate never marked are untouched, including the creation-time highlights.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @private
 */
function clearCellErrors_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  const grid = gridRows_(sheet);
  if (!grid.count) return;
  const range = sheet.getRange(grid.first, 3, grid.count, 1);
  const bgs = range.getBackgrounds();
  const notes = range.getNotes();
  for (let i = 0; i < grid.count; i++) {
    if (String(bgs[i][0]).toLowerCase() !== REVIEW_ERROR_COLOR) continue;
    const cell = sheet.getRange(grid.first + i, 3);
    cell.setBackground(null);
    cell.setNote(stripErrorNote_(notes[i][0]) || null);
  }
}

/**
 * Group "Label: message" gate lines by label (a label can fail twice: typing and dependency). Pure.
 * @param {string[]} errors
 * @return {Object.<string,string[]>}
 * @private
 */
function splitGateErrors_(errors) {
  const out = {};
  (errors || []).forEach(function (e) {
    const i = String(e).indexOf(': ');
    if (i < 1) return;
    const label = e.slice(0, i), msg = e.slice(i + 2);
    (out[label] = out[label] || []).push(msg);
  });
  return out;
}

/**
 * A note with its leading ⚠ paragraph removed; '' when nothing else was there. Pure.
 * @param {string} note
 * @return {string}
 * @private
 */
function stripErrorNote_(note) {
  const s = str_(note);
  if (s.indexOf(REVIEW_ERROR_PREFIX) !== 0) return s;
  const parts = s.split('\n\n');
  return parts.slice(1).join('\n\n');
}

/**
 * Set (or append) a metadata key/value pair in the A/B columns.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} label
 * @param {*} value
 * @private
 */
function setMeta_(sheet, label, value) {
  const last = Math.min(sheet.getLastRow(), 30);
  const col = sheet.getRange(1, 1, last, 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (sameLabel_(col[i][0], label)) { return sheet.getRange(i + 1, 2).setValue(value); }
  }
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1).setValue(label).setFontWeight('bold');
  return sheet.getRange(row, 2).setValue(value);
}

/**
 * Point a review sheet's "Original file" link and "Source file ID" at the kept copy.
 * @param {string} sheetId Review spreadsheet id.
 * @param {GoogleAppsScript.Drive.File} kept
 * @private
 */
function repointSheet_(sheetId, kept) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.SOURCE_ID, kept.getId());
  const col = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 30), 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (sameLabel_(col[i][0], META.ORIGINAL)) {
      sheet.getRange(i + 1, 2).setFormula('=HYPERLINK("' + kept.getUrl() + '","' + kept.getName().replace(/"/g, "'") + '")');
      break;
    }
  }
}

// --- APPROVED COLUMN PLAN AND RULES --------------------------------------------------------------
/** @const {string} Background for an Approved cell the reviewer must look at. */
const REVIEW_FLAG_COLOR = '#fff3cd';

/** @const {number} Largest option list we put in an in-cell dropdown. Above this the cell gets no list, only the note. */
const REVIEW_LIST_MAX = 500;

/** @const {string} Number format for date cells. */
const REVIEW_DATE_FORMAT = 'yyyy-mm-dd';

/** @const {string} Note on multipicklist cells. */
const REVIEW_MULTI_NOTE = 'Pick one from the list, or type several separated by ";" (e.g. Canada; France).';

/** @const {string} Background for the Extracted cell of a [manual] row (nothing was extracted). */
const REVIEW_MANUAL_COLOR = '#eeeeee';

/** @const {string} Note on the Opportunity cell. */
const REVIEW_OPPORTUNITY_NOTE = 'Pick a suggested opportunity, or paste the Opportunity Id (006…) or its Salesforce URL.';

/** @const {string} Note on other [manual] cells. */
const REVIEW_MANUAL_NOTE = 'Enter this value; it is not extracted from the contract.';

/** @const {string} Note on a cell whose extracted text was a "not found" phrase. */
const REVIEW_ABSENT_NOTE = 'The model found nothing for this field; left blank rather than sending the phrase.';

/** @const {string} Note on [info] cells. */
const REVIEW_INFO_NOTE = 'For reference only; not sent to Salesforce.';

/** @const {string} Marker appended to the Field cell of a required row (display only; the label itself is unchanged). */
const REVIEW_REQUIRED_NOTE = 'Required before this contract can be sent to Salesforce.';

/**
 * One row of the plan.
 * @typedef {Object} ApprovedCellPlan
 * @property {string}  label      Config label (column A).
 * @property {string}  extracted  Model text, verbatim (column B).
 * @property {*}       seed       What goes in Approved (column C): string | boolean | Date | ''.
 * @property {boolean} flagged    Highlight the cell.
 * @property {string}  note       Cell note; '' for none.
 * @property {?{kind:string, options:string[], strict:boolean, help:(string|undefined)}} rule
 *                                Validation: kind 'list' | 'checkbox' | 'date'; options for 'list'; null for none.
 * @property {string}  role       'extract' | 'manual' | 'info' (Config output_fields marker).
 * @property {boolean} required   The gate will block the push while this cell is blank.
 */

/**
 * Decide seed, flag, note and rule for every output field. Pure.
 * @param {Config} cfg
 * @param {Schema} schema From loadSchema_(); {} yields a plan with no rules and no flags.
 * @param {string[]} labels cfg.output_fields, in review-sheet order.
 * @param {Object.<string,string>} parsedData Label -> model text.
 * @return {ApprovedCellPlan[]}
 * @private
 */
function planApprovedCells_(cfg, schema, labels, parsedData, candidates) {
  const required = {};
  requiredLabels_(cfg, schema, labels || []).forEach(function (l) { required[l] = true; });

  return (labels || []).map(function (label) {
    const role = fieldRole_(cfg, label);
    const raw = role === 'manual' ? '' : ((parsedData && parsedData[label]) || '');
    const absent = isAbsentPhrase_(cfg, raw);           // "Not mentioned in the document" -> seed blank, show text
    const field = schemaFor_(schema, cfg, label);
    let p;
    if (role === 'manual' && wireKey_(cfg, label) === GATE_OPPORTUNITY_KEY) p = planOpportunityCell_(candidates || []);
    else p = planOneCell_(field, absent ? '' : raw);

    let note = role === 'manual' ? (p.note || REVIEW_MANUAL_NOTE)
      : role === 'info' ? (p.note ? p.note + ' ' + REVIEW_INFO_NOTE : REVIEW_INFO_NOTE)
      : p.note;
    if (absent) note = note ? REVIEW_ABSENT_NOTE + ' ' + note : REVIEW_ABSENT_NOTE;
    const flagged = p.flagged || (!!required[label] && isBlank_(p.seed));   // isBlank_ is false for a boolean seed
    return { label: label, extracted: raw, seed: p.seed, flagged: flagged, note: note, rule: p.rule,
             role: role, required: !!required[label] };
  });
}

/**
 * Plan the Opportunity cell: blank (nothing to extract), with a dropdown of suggestions when the search returned
 * any. Each option is "label [Id]" (candidateOption_), so the gate's normalizeOpportunity_ finds the Id in the
 * chosen text. Advisory, so a pasted Id or URL still passes the cell's own check. Pure.
 * @param {Array<{id:string,label:string}>} candidates
 * @return {{seed:*, flagged:boolean, note:string, rule:?Object}}
 * @private
 */
function planOpportunityCell_(candidates) {
  const options = (candidates || []).map(candidateOption_);
  const rule = options.length && options.length <= REVIEW_LIST_MAX
    ? { kind: 'list', options: options, strict: false, help: REVIEW_OPPORTUNITY_NOTE }
    : null;
  return { seed: '', flagged: false, note: REVIEW_OPPORTUNITY_NOTE, rule: rule };
}

/**
 * Plan one cell from its schema entry and the model's text. Pure.
 * @param {?SchemaField} field
 * @param {string} raw
 * @return {{seed:*, flagged:boolean, note:string, rule:?Object}}
 * @private
 */
function planOneCell_(field, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!field) return { seed: text, flagged: false, note: '', rule: null };

  switch (field.type) {
    case 'picklist': {
      const labels = optionLabels_(field);
      const rule = labels.length && labels.length <= REVIEW_LIST_MAX ? { kind: 'list', options: labels, strict: true } : null;
      if (!text) return { seed: '', flagged: false, note: '', rule: rule };
      const hit = matchOption_(field, text);
      if (hit) return { seed: hit.label || hit.value, flagged: false, note: '', rule: rule };
      return { seed: '', flagged: true, note: 'Extracted "' + text + '" is not an option. Choose one from the list.', rule: rule };
    }
    case 'multipicklist': {
      const labels = optionLabels_(field);
      const rule = labels.length && labels.length <= REVIEW_LIST_MAX ? { kind: 'list', options: labels, strict: false } : null;
      const parts = text ? text.split(GATE_MULTI_SEP).map(function (s) { return s.trim(); }).filter(Boolean) : [];
      const kept = [], dropped = [], seen = {};
      parts.forEach(function (part) {
        const hit = matchOption_(field, part);
        if (!hit) { dropped.push(part); return; }
        const l = hit.label || hit.value;
        if (!seen[l]) { seen[l] = true; kept.push(l); }
      });
      const note = dropped.length
        ? 'Extracted "' + dropped.join('; ') + '" ' + (dropped.length === 1 ? 'is not an option' : 'are not options') + ' and was left out. ' + REVIEW_MULTI_NOTE
        : REVIEW_MULTI_NOTE;
      return { seed: kept.join('; '), flagged: dropped.length > 0, note: note, rule: rule };
    }
    case 'boolean': {
      const rule = { kind: 'checkbox', options: [], strict: true };
      if (!text) return { seed: false, flagged: false, note: '', rule: rule };
      const r = normalizeBool_(text);
      if (r.ok) return { seed: r.value, flagged: false, note: '', rule: rule };
      return { seed: false, flagged: true, note: 'Extracted "' + text + '" is not yes/no. Tick if it applies.', rule: rule };
    }
    case 'date': {
      const rule = { kind: 'date', options: [], strict: false };
      if (!text) return { seed: '', flagged: false, note: '', rule: rule };
      const d = isoToLocalDate_(text) || toDate_(text);
      if (d) return { seed: d, flagged: false, note: '', rule: rule };
      return { seed: text, flagged: true, note: 'Not a date. Enter one as YYYY-MM-DD or pick from the calendar (double-click).', rule: rule };
    }
    default: {
      // Numbers, text, urls, references: keep the model's text; flag it if the gate would reject it.
      const r = normalizeValue_(field, text);
      if (r.ok) return { seed: text, flagged: false, note: '', rule: null };
      return { seed: text, flagged: true, note: r.message, rule: null };
    }
  }
}

/**
 * Option labels for a dropdown, in schema order (labels are what the reviewer reads; the gate maps them back).
 * @param {SchemaField} field
 * @return {string[]}
 * @private
 */
function optionLabels_(field) {
  return (field.values || []).map(function (v) { return v.label || v.value; });
}

/**
 * 'yyyy-MM-dd' -> Date at local midnight (so Sheets shows the same calendar day), else null.
 * @param {string} s
 * @return {?Date}
 * @private
 */
function isoToLocalDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Carry a plan out on the Approved column: validation rules in one call, then checkboxes, date formats, highlights
 * and notes per row that needs them. Values must already be written (see design note 3).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The review tab.
 * @param {number} firstRow Sheet row of the first field (the row after the grid header).
 * @param {ApprovedCellPlan[]} plan
 * @return {void}
 * @private
 */
function applyApprovedPlan_(sheet, firstRow, plan) {
  if (!plan || !plan.length) return;
  const col = 3;                                             // Approved
  const column = sheet.getRange(firstRow, col, plan.length, 1);

  const rules = plan.map(function (p) { return [toDataValidation_(p.rule)]; });
  if (rules.some(function (r) { return r[0] !== null; })) column.setDataValidations(rules);

  plan.forEach(function (p, i) {
    const cell = sheet.getRange(firstRow + i, col);
    if (p.rule && p.rule.kind === 'checkbox') cell.insertCheckboxes();
    if (p.rule && p.rule.kind === 'date') cell.setNumberFormat(REVIEW_DATE_FORMAT);
    if (p.flagged) cell.setBackground(REVIEW_FLAG_COLOR);
    if (p.note) cell.setNote(p.note);
    if (p.role === 'manual') sheet.getRange(firstRow + i, 2).setBackground(REVIEW_MANUAL_COLOR);   // Extracted: nothing to show
    if (p.required) sheet.getRange(firstRow + i, 1).setFontWeight('bold').setNote(REVIEW_REQUIRED_NOTE);
  });
}

/**
 * Plan rule -> Sheets DataValidation (or null).
 * @param {?{kind:string, options:string[], strict:boolean}} rule
 * @return {?GoogleAppsScript.Spreadsheet.DataValidation}
 * @private
 */
function toDataValidation_(rule) {
  if (!rule || rule.kind === 'checkbox') return null;
  const b = SpreadsheetApp.newDataValidation().setAllowInvalid(!rule.strict);
  switch (rule.kind) {
    case 'list':     return b.requireValueInList(rule.options, true)
                       .setHelpText(rule.help || (rule.strict ? 'Choose one from the list.' : REVIEW_MULTI_NOTE)).build();
    case 'checkbox': return null;                         // insertCheckboxes() installs its own rule
    case 'date':     return b.requireDate().setHelpText('Enter a date as YYYY-MM-DD or double-click for a calendar.').build();
    default:         return null;
  }
}
