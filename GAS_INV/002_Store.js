/**
 * Store.gs — the output sheet IS the state store for rows.
 * Loaded into a Map keyed by `key` at the start of each invocation, written back at the end.
 * Checkpointing across invocations therefore needs only a page token in Properties.
 */

const COLUMNS = [
  'key', 'scriptId', 'name', 'kind', 'owner', 'modified', 'location', 'link',
  'libraries', 'advancedServices', 'oauthScopes', 'manifestStatus',
  'lastExecution', 'executionCount', 'executionTypes', 'lastSeen',
];

function loadStore_(cfg) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(cfg.OUTPUT_SHEET) || ss.insertSheet(cfg.OUTPUT_SHEET);
  const rows = new Map();

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, COLUMNS.length).getValues().forEach(values => {
      const row = {};
      COLUMNS.forEach((c, i) => (row[c] = values[i]));
      if (row.key) rows.set(row.key, row);
    });
  }
  return { sheet, rows };
}

function saveStore_(store) {
  const out = [COLUMNS];
  for (const row of store.rows.values()) out.push(COLUMNS.map(c => row[c] ?? ''));

  store.sheet.clearContents();
  store.sheet.getRange(1, 1, out.length, COLUMNS.length).setValues(out);
  store.sheet.setFrozenRows(1);
}

function upsert_(store, key, fields) {
  const row = store.rows.get(key) || { key };
  Object.assign(row, fields);
  store.rows.set(key, row);
  return row;
}

/** Standalone rows grouped by name — used to attach execution history to Drive rows. */
function indexByName_(store) {
  const index = new Map();
  for (const row of store.rows.values()) {
    if (row.kind !== 'standalone') continue;
    if (!index.has(row.name)) index.set(row.name, []);
    index.get(row.name).push(row);
  }
  return index;
}

/** Sheets may hand ISO strings back as Date objects; normalise for string comparison. */
function iso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}
