/**
 * Config.gs — reads run options from a key/value "Config" sheet.
 * Missing keys fall back to CONFIG_DEFAULTS; values are coerced to the default's type.
 */

const CONFIG_SHEET_NAME = 'Config';

// key: [default, description]
const CONFIG_DEFAULTS = {
  OUTPUT_SHEET:            ['Inventory', 'Sheet that receives one row per project'],
  INCLUDE_SHARED_WITH_ME:  [true,  'Include standalone projects other people own and shared with you'],
  INCLUDE_SHARED_DRIVES:   [true,  'Search shared drives as well as My Drive'],
  FETCH_MANIFESTS:         [true,  'Export each project and read appsscript.json (libraries, scopes, services)'],
  SCAN_EXECUTIONS:         [true,  'Read your execution history to surface projects Drive cannot list (bound scripts etc.)'],
  EXECUTION_LOOKBACK_DAYS: [30,    'How many days of execution history to read'],
  TIME_BUDGET_SECONDS:     [300,   'Work this long per invocation, then checkpoint and resume via trigger'],
};

function getConfig() {
  const cfg = {};
  for (const k in CONFIG_DEFAULTS) cfg[k] = CONFIG_DEFAULTS[k][0];

  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return cfg;

  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(([key, value]) => {
    if (!(key in cfg) || value === '') return;
    const def = cfg[key];
    cfg[key] = typeof def === 'boolean' ? String(value).toLowerCase() === 'true'
             : typeof def === 'number'  ? Number(value)
             : String(value);
  });
  return cfg;
}

/** Creates the Config sheet populated with defaults. Safe to run repeatedly. */
function setupConfigSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CONFIG_SHEET_NAME) || ss.insertSheet(CONFIG_SHEET_NAME);
  if (sh.getLastRow() > 0) return;

  const rows = [['Key', 'Value', 'Description']];
  for (const k in CONFIG_DEFAULTS) rows.push([k, CONFIG_DEFAULTS[k][0], CONFIG_DEFAULTS[k][1]]);
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, 3);
}
