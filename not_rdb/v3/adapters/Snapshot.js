/**
 * @file adapters/Snapshot.gs
 * @summary The `_queue` tab: a snapshot of what is in the pending folder RIGHT NOW, plus two heartbeat cells,
 * rewritten wholesale by the pollers. It is a projection, never a source of truth.
 *
 * @description Why this exists and why it is shaped this way:
 *   1. The pending folder is the queue; each review sheet's Status cell is its state. processApprovals() already
 *      opens every pending sheet each run and then throws that knowledge away. This module keeps it, for the
 *      dashboard, at the cost of one clear + one setValues per run.
 *   2. OVERWRITE, never update. The table is cleared and rewritten from scratch every run, so it cannot accumulate
 *      drift. If a run dies mid-loop the previous snapshot simply stands, and the heartbeat cell says how old it is.
 *   3. The heartbeats are the only thing here the `_logs` tab cannot provide. The log records events; a trigger that
 *      has silently died produces no events, which looks exactly like a quiet day. A "Last checked" timestamp that
 *      stops moving is the difference.
 *   4. Fixed layout, not label-scanned. The tab is machine-owned (underscore prefix, like `_logs`); the dashboard is
 *      the only reader and it is code we control. Keeping it positional keeps this file small.
 *
 * LAYOUT
 *   A1  Last ingestion check   B1  <Date>
 *   A2  Last approvals check   B2  <Date>
 *   A3  (blank)
 *   A4  Contract | Status | Approved? | Extracted At | Last Error | Sheet URL | Correlation ID
 *   A5+ one row per review sheet still in pending after this run
 */

/** @const {string} Tab holding the queue snapshot, inside the config spreadsheet. */
const QUEUE_SHEET_NAME = '_queue';

/** @const {number} Row of the snapshot table header; data starts on the next row. */
const QUEUE_HEADER_ROW = 4;

/** @const {string[]} Snapshot table header. Column order is the contract with readQueueRows_(). */
const QUEUE_HEADERS = ['Contract', 'Status', 'Approved?', 'Extracted At', 'Last Error', 'Sheet URL', 'Correlation ID', 'Source URL'];

/**
 * Heartbeat labels and the fixed row each lives on.
 * @const {Object.<string,{label:string,row:number}>}
 */
const HEARTBEAT = {
  INGESTION: { label: 'Last ingestion check', row: 1 },
  APPROVALS: { label: 'Last approvals check', row: 2 }
};

/**
 * Shape one snapshot row from what processApprovals() learned about a pending sheet. Pure.
 * @param {string} name       Review sheet file name.
 * @param {string} url        Review sheet url.
 * @param {?Approval} approval Read-back of the sheet, or null if it could not be opened.
 * @param {string} [errMsg]   Error from this run, if the push (or the open) failed.
 * @return {Array<*>} A row in QUEUE_HEADERS order.
 * @private
 */
function queueRow_(name, url, approval, errMsg) {
  if (!approval) return [name, 'Unreadable', '', '', errMsg || '', url, '', ''];
  const status = errMsg ? 'Error' : (approval.status || 'Pending Review');
  return [
    name,
    status,
    approval.approved === true,
    approval.extractedAt || '',
    errMsg || approval.lastError || '',
    url,
    approval.correlationId || '',
    approval.fileId ? driveUrl_(approval.fileId) : ''
  ];
}

/**
 * Replace the snapshot table with `rows`. Clears from the header row down, then rewrites header and rows,
 * so a hand-edit to the tab is healed on the next run rather than accumulated.
 * @param {Array<Array<*>>} rows Output of queueRow_(), one per pending sheet.
 * @return {void}
 * @private
 */
function writeQueueSnapshot_(rows) {
  const sheet = getQueueSheet_();
  const last = sheet.getLastRow();
  if (last >= QUEUE_HEADER_ROW) {
    sheet.getRange(QUEUE_HEADER_ROW, 1, last - QUEUE_HEADER_ROW + 1, QUEUE_HEADERS.length).clearContent();
  }
  sheet.getRange(QUEUE_HEADER_ROW, 1, 1, QUEUE_HEADERS.length).setValues([QUEUE_HEADERS]).setFontWeight('bold');
  if (rows.length) sheet.getRange(QUEUE_HEADER_ROW + 1, 1, rows.length, QUEUE_HEADERS.length).setValues(rows);
}

/**
 * Stamp "now" into a heartbeat cell. Call at the END of a poller run, after the loop, so a run that throws
 * before finishing leaves the previous stamp in place and the dashboard sees it go stale.
 * @param {{label:string,row:number}} hb One of HEARTBEAT.*.
 * @return {void}
 * @private
 */
function heartbeat_(hb) {
  const sheet = getQueueSheet_();
  sheet.getRange(hb.row, 1, 1, 2).setValues([[hb.label, new Date()]]);
  sheet.getRange(hb.row, 1).setFontWeight('bold');
}

/**
 * The `_queue` sheet, created on first use. Not cached: the two pollers run in separate executions and each
 * touches it once or twice, so there is nothing to save.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @private
 */
function getQueueSheet_() {
  const ss = getConfigSpreadsheet_();
  let sheet = ss.getSheetByName(QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(QUEUE_SHEET_NAME);
    sheet.getRange(HEARTBEAT.INGESTION.row, 1).setValue(HEARTBEAT.INGESTION.label).setFontWeight('bold');
    sheet.getRange(HEARTBEAT.APPROVALS.row, 1).setValue(HEARTBEAT.APPROVALS.label).setFontWeight('bold');
    sheet.getRange(QUEUE_HEADER_ROW, 1, 1, QUEUE_HEADERS.length).setValues([QUEUE_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(QUEUE_HEADER_ROW);
    sheet.setColumnWidth(1, 320).setColumnWidth(5, 360).setColumnWidth(6, 120).setColumnWidth(7, 300);
  }
  return sheet;
}

/**
 * Read both heartbeat cells.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The `_queue` sheet.
 * @return {{ingestion:?string, approvals:?string}} ISO timestamps, or null if never stamped.
 * @private
 */
function readHeartbeats_(sheet) {
  const vals = sheet.getRange(1, 2, 2, 1).getValues();
  return {
    ingestion: toIso_(vals[HEARTBEAT.INGESTION.row - 1][0]),
    approvals: toIso_(vals[HEARTBEAT.APPROVALS.row - 1][0])
  };
}

/**
 * Read the snapshot table into objects. Dates become ISO strings because google.script.run cannot
 * return Date instances to the browser.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet The `_queue` sheet.
 * @return {Array<{name:string,status:string,approved:boolean,extractedAt:?string,lastError:string,url:string,correlationId:string}>}
 * @private
 */
function readQueueRows_(sheet) {
  const last = sheet.getLastRow();
  if (last <= QUEUE_HEADER_ROW) return [];
  const vals = sheet.getRange(QUEUE_HEADER_ROW + 1, 1, last - QUEUE_HEADER_ROW, QUEUE_HEADERS.length).getValues();
  return vals
    .filter(function (r) { return String(r[0] || '').trim() !== ''; })
    .map(function (r) {
      return {
        name: String(r[0]),
        status: String(r[1] || ''),
        approved: r[2] === true || String(r[2]).toUpperCase() === 'TRUE',
        extractedAt: toIso_(r[3]),
        lastError: String(r[4] || ''),
        url: String(r[5] || ''),
        correlationId: String(r[6] || ''),
        sourceUrl: String(r[7] || '')
      };
    });
}

/**
 * Coerce a cell value to an ISO timestamp string, or null if it is not a usable date. Pure.
 * @param {*} v A Date, an ISO string, or anything else.
 * @return {?string}
 * @private
 */
function toIso_(v) {
  if (v == null || v === '') return null;
  const d = (v instanceof Date) ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
