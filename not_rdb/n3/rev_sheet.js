/**
 * @file ReviewSheet.gs — what the Approved column looks like when the reviewer opens it: dropdowns on picklists,
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
 *
 * WIRING
 *   processIngestion():  const schema = loadSchema_();   -> extractOneFile_(file, cfg, pending, schema)
 *   createReviewSheet_(parsedData, file, sources, cfg, pendingFolder, schema):
 *       const plan = planApprovedCells_(cfg, schema, cfg.output_fields, parsedData);
 *       rows = plan.map(p => [p.label, p.extracted, p.seed]);  ... setValues(rows) ...
 *       applyApprovedPlan_(sheet, headerRow + 1, plan);
 */

/** @const {string} Background for an Approved cell the reviewer must look at. */
const REVIEW_FLAG_COLOR = '#fff3cd';
/** @const {number} Largest option list we put in an in-cell dropdown. Above this the cell gets no list, only the note. */
const REVIEW_LIST_MAX = 500;
/** @const {string} Number format for date cells. */
const REVIEW_DATE_FORMAT = 'yyyy-mm-dd';
/** @const {string} Note on multipicklist cells. */
const REVIEW_MULTI_NOTE = 'Pick one from the list, or type several separated by ";" (e.g. Canada; France).';

/**
 * One row of the plan.
 * @typedef {Object} ApprovedCellPlan
 * @property {string}  label      Config label (column A).
 * @property {string}  extracted  Model text, verbatim (column B).
 * @property {*}       seed       What goes in Approved (column C): string | boolean | Date | ''.
 * @property {boolean} flagged    Highlight the cell.
 * @property {string}  note       Cell note; '' for none.
 * @property {?{kind:string, options:string[], strict:boolean}} rule
 *                                Validation: kind 'list' | 'checkbox' | 'date'; options for 'list'; null for none.
 */


// --- PLAN (pure) ----------------------------------------------------------------------------
/**
 * Decide seed, flag, note and rule for every output field. Pure.
 * @param {Config} cfg
 * @param {Schema} schema From loadSchema_(); {} yields a plan with no rules and no flags.
 * @param {string[]} labels cfg.output_fields, in review-sheet order.
 * @param {Object.<string,string>} parsedData Label -> model text.
 * @return {ApprovedCellPlan[]}
 * @private
 */
function planApprovedCells_(cfg, schema, labels, parsedData) {
  return (labels || []).map(function (label) {
    const raw = (parsedData && parsedData[label]) || '';
    const field = schemaFor_(schema, cfg, label);
    const p = planOneCell_(field, raw);
    return { label: label, extracted: raw, seed: p.seed, flagged: p.flagged, note: p.note, rule: p.rule };
  });
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


// --- APPLY (Sheets) -------------------------------------------------------------------------
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
    case 'list':     return b.requireValueInList(rule.options, true).setHelpText(rule.strict ? 'Choose one from the list.' : REVIEW_MULTI_NOTE).build();
    case 'checkbox': return null;                         // insertCheckboxes() installs its own rule
    case 'date':     return b.requireDate().setHelpText('Enter a date as YYYY-MM-DD or double-click for a calendar.').build();
    default:         return null;
  }
}
