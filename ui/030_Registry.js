/**
 * Registry — the "implementation record": what engagements exist, their state,
 * and which workbook each is bound to.
 *
 * This is deliberately the ONLY module that knows where that record lives.
 * Today the real store is RTR_Pool behind the router's lifecycle endpoints
 * (list / claim / release / close), reached through lib_sdc 1.9.0's Registry
 * module. The eventual database replaces the body of this file and nothing else.
 *
 * Two modes, chosen by script property REGISTRY_MODE:
 *   dry_run (default)  records to a `demo_registry` tab in this app's own
 *                      spreadsheet. Nothing is claimed in Workato. This is the
 *                      honest setting for a demonstration.
 *   live               delegates to SDC.Registry.* — NOT exercised by this
 *                      demo; the calls are written against the 1.9.0 module's
 *                      intent and must be checked against 013_Registry.js.
 */
var Registry = (function () {

  var HEADERS = ['created_at', 'created_by', 'client_name', 'spreadsheet_id', 'workbook_url', 'state', 'workspace_key', 'mode'];

  function mode_() { return PropertiesService.getScriptProperties().getProperty('REGISTRY_MODE') || 'dry_run'; }

  function sheet_() {
    var id = PropertiesService.getScriptProperties().getProperty('DEMO_REGISTRY_SHEET_ID');
    var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('demo_registry');
    if (!sh) { sh = ss.insertSheet('demo_registry'); sh.appendRow(HEADERS); sh.setFrozenRows(1); }
    return sh;
  }

  /** Record a newly created, not-yet-provisioned implementation. */
  function recordCreated(args) {
    if (mode_() === 'live') {
      // Intent: claim a pool workspace and bind this workbook to it.
      // Expected shape from lib_sdc 1.9.0 013_Registry.js — verify before enabling.
      return SDC.Registry.claim({ spreadsheetId: args.spreadsheetId, clientName: args.clientName });
    }
    var row = [new Date().toISOString(), Session.getActiveUser().getEmail(), args.clientName,
               args.spreadsheetId, args.url, 'created (not claimed)', '', 'dry_run'];
    sheet_().appendRow(row);
    return { mode: 'dry_run', state: 'created (not claimed)', workspaceKey: null };
  }

  /** Everything the app knows about, newest first. */
  function list() {
    if (mode_() === 'live') return SDC.Registry.list();
    var rows = sheet_().getDataRange().getValues().slice(1);
    return rows.reverse().map(function (r) {
      var o = {}; HEADERS.forEach(function (h, i) { o[h] = r[i]; }); return o;
    });
  }

  return { recordCreated: recordCreated, list: list, mode: mode_ };
})();
