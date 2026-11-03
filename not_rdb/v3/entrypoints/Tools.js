/**
 * @file entrypoints/Tools.gs — operator and developer conveniences: the Config-sheet menu, the `_models` dropdown,
 * and the functions you run by hand from the editor (validate config, check folder access, debug the picker).
 *
 * @summary Two things: a live list of the Gemini models this project can call, written to a `_models` tab and
 * offered as a dropdown on the Config `model` cell; and a "Contract Intake" menu in the Config spreadsheet so the
 * team can refresh that list and validate the config without opening the script editor.
 *
 * @description
 *   1. The model list comes from Vertex AI Model Garden's publisher-models endpoint, called with the running
 *      user's OAuth token exactly as callGemini_ does, against the same location the pipeline uses. The raw
 *      catalogue is large (embedding, image, live-audio and TTS models included); parseModelList_() keeps only
 *      Gemini models a text/document generateContent call can use, and drops deprecated ones.
 *   2. The dropdown ALLOWS values not in the list. A newer preview, or a model the catalogue lags on, must still
 *      be typeable; the list is a convenience, not a gate. readConfig_ is unchanged and still reads the cell.
 *   3. The menu (onOpen) appears only when this project is BOUND to the Config spreadsheet. If Config is reached
 *      via Script Property CONFIG_SHEET_ID instead, run refreshModelList() from the editor or on a time trigger.
 *
 * DEPLOY: clasp push only. Nothing here is served by the web app. Reload the Config spreadsheet to see the menu.
 */

// --- MENU (BOUND SPREADSHEET ONLY) ---------------------------------------------------------------
/**
 * Adds the "Contract Intake" menu when the Config spreadsheet opens. Simple trigger: runs only if this project is
 * bound to that spreadsheet, and only with the opener's authorization. Menu items call the functions below.
 * @return {void}
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Contract Intake')
      .addItem('Refresh model list', 'refreshModelList')
      .addItem('Validate config', 'validateConfigUi')
      .addItem('Check folder access', 'checkAccessUi')
      .addItem('Check Vertex access', 'checkVertexAccessUi')
      .addToUi();
  } catch (e) { /* no UI (editor run, or not bound) */ }
}

// --- VALIDATE ------------------------------------------------------------------------------------
/**
 * Validate config without processing anything; logs the parsed field list.
 * @return {Config}
 */
function validateConfig() {
  const cfg = readConfig_();
  Logger.log('Config OK. Fields: ' + cfg.output_fields.map(function (l) { return l + ' -> ' + wireKey_(cfg, l); }).join(', '));
  return cfg;
}

/**
 * validateConfig() with the result shown in the spreadsheet rather than the log.
 * @return {void}
 */
function validateConfigUi() {
  let msg;
  try {
    const cfg = readConfig_();
    msg = 'Config OK.\n\nModel: ' + (cfg.model || '(default)') + '\nFields: ' + cfg.output_fields.join(', ');
  } catch (err) {
    msg = 'Config problem:\n\n' + err.message;
  }
  try { SpreadsheetApp.getUi().alert('Contract Intake', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log(msg); }
}

// --- VERTEX ACCESS -------------------------------------------------------------------------------
/**
 * Manual entry: prove the configured model identity works before a contract depends on it. Mints a token if a
 * service account is configured (so a missing IAM grant fails HERE, with the account named), then lists the
 * publisher models with that token (so a missing aiplatform grant fails here too). Logs and returns one line.
 * @return {string}
 */
function checkVertexAccess() {
  const cfg = readConfig_();
  const who = vertexIdentity_(cfg);
  const label = who.mode === 'runner' ? 'the runner (' + runnerEmail_() + ')' : 'service account ' + who.email + ' (impersonated by ' + runnerEmail_() + ')';
  let text;
  try {
    vertexToken_(cfg);                                        // mints when a service account is configured
    const models = listPublisherModels_(cfg);
    text = 'OK    Vertex calls run as ' + label + '; ' + models.length + ' Gemini models visible in ' + (cfg.location || 'global') + '.';
  } catch (err) {
    text = 'FAIL  Vertex calls run as ' + label + ': ' + err.message;
  }
  Logger.log(text);
  return text;
}

/** Same as checkVertexAccess(), shown in a dialog. */
function checkVertexAccessUi() {
  const ui = SpreadsheetApp.getUi();
  ui.alert('Vertex access', checkVertexAccess(), ui.ButtonSet.OK);
}

// --- FOLDER ACCESS -------------------------------------------------------------------------------
/**
 * Manual / menu entry: one line per folder plus the identity that was checked. Returns the text it logged.
 * @return {string}
 */
function checkAccess() {
  const cfg = readConfig_();
  const lines = checkFolderAccess_(cfg).map(function (r) {
    return (r.ok ? 'OK    ' : 'FAIL  ') + r.key + '  ' + (r.name || r.id || '(unset)') +
      (r.id ? (r.sharedDrive ? '  [shared drive]' : '  [My Drive — move to a shared drive]') : '') +
      (r.problems.length ? '\n        ' + r.problems.join('\n        ') : '') +
      (r.notes.length ? '\n        note: ' + r.notes.join('\n        note: ') : '');
  });
  const text = 'Checked as ' + runnerEmail_() + '\n' + lines.join('\n');
  Logger.log(text);
  return text;
}

/** Same as checkAccess(), shown in a dialog. Wire into onOpen(): .addItem('Check folder access', 'checkAccessUi'). */
function checkAccessUi() {
  const ui = SpreadsheetApp.getUi();
  ui.alert('Folder access', checkAccess(), ui.ButtonSet.OK);
}

// --- MODEL LIST ----------------------------------------------------------------------------------
/** @const {string} Tab that holds the fetched model catalogue, inside the config spreadsheet. */
const MODELS_SHEET_NAME = '_models';

/** @const {string[]} Header row of the `_models` tab. */
const MODELS_HEADERS = ['Model', 'Launch stage', 'Version', 'Fetched'];

/**
 * Fetch the Gemini catalogue, write it to `_models`, and put a dropdown on the Config `model` cell.
 * Safe to run any time; it rewrites the tab wholesale. Logs and (when a UI exists) shows a one-line result.
 * @return {number} Models written.
 */
function refreshModelList() {
  const cfg = readConfig_();
  const models = listPublisherModels_(cfg);
  if (!models.length) throw new Error('Vertex returned no usable Gemini models for location "' + (cfg.location || 'global') + '".');

  const ss = getConfigSpreadsheet_();
  let sheet = ss.getSheetByName(MODELS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(MODELS_SHEET_NAME);
  sheet.clearContents();
  const fetched = new Date();
  sheet.getRange(1, 1, 1, MODELS_HEADERS.length).setValues([MODELS_HEADERS]).setFontWeight('bold');
  sheet.getRange(2, 1, models.length, MODELS_HEADERS.length)
    .setValues(models.map(function (m) { return [m.id, m.stage, m.version, fetched]; }));
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, MODELS_HEADERS.length);

  const listRange = sheet.getRange(2, 1, models.length, 1);
  const cell = configValueCell_(ss, 'model');
  if (cell) {
    cell.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(listRange, true)
      .setAllowInvalid(true)                                   // a convenience, not a gate
      .setHelpText('Gemini models available to this project (Contract Intake > Refresh model list). You may type one that is not listed.')
      .build());
    cell.setNote('List refreshed ' + fetched.toISOString() + ' · ' + models.length + ' models · location ' + (cfg.location || 'global'));
  }

  const summary = models.length + ' models written to ' + MODELS_SHEET_NAME + (cell ? '; dropdown set on Config > model.' : '; Config has no "model" row, so no dropdown was set.');
  logInfo_('refreshModelList', summary);
  try { SpreadsheetApp.getUi().alert('Contract Intake', summary, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* no UI */ }
  return models.length;
}

/**
 * The Config value cell (column B) for a given key in column A, or null if the key is absent.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} key
 * @return {?GoogleAppsScript.Spreadsheet.Range}
 * @private
 */
function configValueCell_(ss, key) {
  const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) return null;
  const keys = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (sameLabel_(keys[i][0], key)) return sheet.getRange(i + 1, 2);
  }
  return null;
}

// --- MANUAL SMOKE TEST ---------------------------------------------------------------------------
/** -----------------------------------------------------------------------------
 * MANUAL END-TO-END SMOKE TEST (the service-bound paths)
 * -----------------------------------------------------------------------------
 * 1. validateConfig()                  — config keys present and typed.
 * 2. Drop a known PDF in the ingestion folder. Run processIngestion() manually.
 *    Expect: a review sheet in pending, the original in processed, a Chat ping.
 * 3. Drop a deliberately garbled/blank file. Run processIngestion().
 *    Expect: original in FAILED, a Chat failure ping, no review sheet.
 * 4. Open the review sheet, change one Approved cell, tick Approved?.
 *    Run processApprovals(). Expect: Workato receives the corrected value (not
 *    the extracted one), sheet Status=Pushed, sheet moved to pushed.
 * 5. Run processApprovals() again immediately. Expect: nothing re-sent (sheet
 *    already in pushed). If you re-push the same correlation_id by hand, confirm
 *    Salesforce upserts rather than duplicating.
 * ---------------------------------------------------------------------------
 */

// --- PICKER --------------------------------------------------------------------------------------
function debugPicker() {
  var cfg = pickerConfig_(readConfig_());
  var here = ScriptApp.getService().getUrl() || '(not deployed)';
  Logger.log('picker_url (Config):  ' + (cfg ? cfg.url : '(not set - button hidden)'));
  Logger.log('this dashboard\'s URL: ' + here);
  var id = function (u) { var m = /\/macros\/s\/([^\/]+)\//.exec(u || ''); return m ? m[1] : ''; };
  if (cfg && id(cfg.url) && id(cfg.url) === id(here)) {
    Logger.log('PROBLEM: picker_url is this dashboard\'s own URL. It must be the DrivePicker project\'s web-app /exec URL.');
  }
  Logger.log('library ' + DrivePicker.VERSION + ' | mount takes url: ' + (DrivePicker.clientHtml().indexOf('url,') !== -1));
}
