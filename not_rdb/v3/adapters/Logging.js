/**
 * @file adapters/Logging.gs 
 * @summary Dual-write AppLogger pattern: every call writes to a _logs tab AND to Stackdriver (console). The sheet 
 * is the human-visible audit; the console is the fallback if the sheet write fails.
 *
 * @description Three deliberate choices, all learned the hard way:
 *   1. No LockService here. Both entry points already hold the script lock, so every append is already serialized. 
 *      appendRow() is used instead of getLastRow()+setValues() so there's no manual last-row race to begin with.
 *   2. The log sheet name is a constant, NOT a config key. Logging must keep working even when readConfig_ is the thing 
 *      that just threw — otherwise we can't log the config failure.
 *   3. The tab is created visible.
 */

/** @const {string} Tab to which the logs are appended, inside the config spreadsheet. */
const LOG_SHEET_NAME = '_logs';

/** @const {string[]} Header rows written when the tab is first created.  */
const LOG_HEADERS = ['Timestamp', 'Level', 'Context', 'Correlation ID', 'Message', 'Details'];

/**
 * Cached log sheet for the duration of a single execution (globals reset per run), so that loops do not reopen
 * the spreadsheet for each write.
 * @type {?GoogleAppsScript.Spreadsheet.Sheet}
 */
var logSheetCache_ = null;   // cached for the duration of one execution

/**
 * Append an INFO log line.
 * @param {string} ctx        Short source context, e.g., 'processIngestion'.
 * @param {string} msg        Human-readable message.
 * @param {string} [corr]     Correlation ID, to thread a contract, end-to-end.
 * @param {string} [details]  Extra detail (url, error text, etc.).
 * @private
 */
function logInfo_(ctx, msg, corr, details)  { writeLog_('INFO',  ctx, msg, corr, details); }

/**
 * Append a WARN log line.
 * @param {string} ctx        Short source context, e.g., 'processIngestion'.
 * @param {string} msg        Human-readable message.
 * @param {string} [corr]     Correlation ID, to thread a contract, end-to-end.
 * @param {string} [details]  Extra detail (url, error text, etc.).
 * @private
 */
function logWarn_(ctx, msg, corr, details)  { writeLog_('WARN',  ctx, msg, corr, details); }

/**
 * Append an ERROR log line.
 * @param {string} ctx        Short source context, e.g., 'processIngestion'.
 * @param {string} msg        Human-readable message.
 * @param {string} [corr]     Correlation ID, to thread a contract, end-to-end.
 * @param {string} [details]  Extra detail (url, error text, etc.).
 * @private
 */
function logError_(ctx, msg, corr, details) { writeLog_('ERROR', ctx, msg, corr, details); }

/**
 * Core writer: console first, then the sheet.
 * Errors are reported to the console, never thrown or swallowed.
 * @param {string} level      'INFO' | 'WARN' | 'ERROR'.
 * @param {string} ctx        Source context.
 * @param {string} msg        Message.
 * @param {string} [corr]     Correlation ID
 * @param {string} [details]  Extra detail.
 * @private
 */
function writeLog_(level, ctx, msg, corr, details) {
  // Console first, so there is ALWAYS a trail even if the sheet write fails.
  var line = formatLogLine_(level, ctx, msg, corr, details);
  if (level === 'ERROR')      console.error(line);
  else if (level === 'WARN')  console.warn(line);
  else                        console.log(line);

  try {
    var sheet = getLogSheet_();
    sheet.appendRow([new Date(), level, ctx || '', corr || '', String(msg),
                     details ? String(details) : '']);
    var bg = (level === 'ERROR') ? '#fde7e9' : (level === 'WARN') ? '#fff4e5' : null;
    if (bg) sheet.getRange(sheet.getLastRow(), 1, 1, LOG_HEADERS.length).setBackground(bg);

  } catch (e) {
    // Do not throw out of the logger — but do not hide it either.
    console.error('Log sheet write failed: ' + e.message + ' | dropped: ' + line);
  }
}

/**
 * Render a single console log line. Pure, so unit-testing is possible.
 * @param {string} level
 * @param {string} ctx
 * @param {string} msg
 * @param {string} [corr]
 * @param {string} [details]
 * @return {string} e.g., "[ERROR] [push] {corr-1} message - detail".
 * @private
 */
function formatLogLine_(level, ctx, msg, corr, details) {
  return '[' + level + '] [' + (ctx || '') + ']' +
         (corr ? ' {' + corr + '}' : '') + ' ' + msg +
         (details ? ' — ' + details : '');
}

/** 
 * The _logs sheet, created with headers on first use, then cached for the run. 
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @private
 * */
function getLogSheet_() {
  if (logSheetCache_) return logSheetCache_;
  var ss = getConfigSpreadsheet_();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  logSheetCache_ = sheet;
  return sheet;
}
