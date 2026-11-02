/**
 * Registry — the implementation record. The only file that knows where it lives.
 *
 * live     SDC.Registry.claim(settings, {clientName, spreadsheetId, workbookUrl}) → {workspace_key, state, ...}
 *          then SDC.Registry.applyToWorkbook(ss, {routerBaseUrl, workspaceKey}) writes router.baseUrl and
 *          meta.workspace_key into the new workbook. Exactly what the routing workbook's "Claim workspace" does.
 * dry_run  (default) appends to a `demo_registry` tab in this app's own spreadsheet. Nothing reaches Workato.
 *
 * Settings for live mode come from the host spreadsheet's `_settings` tab (router.lifecycleBaseUrl, router.apiToken,
 * router.baseUrl — same B/C/D column convention as _developer_settings), falling back to script properties
 * ROUTER_LIFECYCLE_BASE_URL / ROUTER_API_TOKEN / ROUTER_BASE_URL.
 */
var Registry = (function () {

  var HEADERS = ['created_at', 'created_by', 'client_name', 'spreadsheet_id', 'workbook_url', 'state', 'workspace_key', 'correlation_id'];

  function props_() { return PropertiesService.getScriptProperties(); }
  function mode() { return props_().getProperty('REGISTRY_MODE') || 'dry_run'; }
  function host_() {
    var id = props_().getProperty('HOST_SPREADSHEET_ID');
    return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  }

  function settings_() {
    var out = { lifecycleBaseUrl: props_().getProperty('ROUTER_LIFECYCLE_BASE_URL') || '',
                apiToken:         props_().getProperty('ROUTER_API_TOKEN') || '',
                baseUrl:          props_().getProperty('ROUTER_BASE_URL') || '' };
    var ss = host_(), sh = ss && ss.getSheetByName('_settings');
    if (sh) {
      sh.getDataRange().getValues().forEach(function (r) {
        if (r[1] !== 'router') return;
        if (r[2] === 'lifecycleBaseUrl' && r[3]) out.lifecycleBaseUrl = String(r[3]).trim();
        if (r[2] === 'apiToken'         && r[3]) out.apiToken         = String(r[3]).trim();
        if (r[2] === 'baseUrl'          && r[3]) out.baseUrl          = String(r[3]).trim();
      });
    }
    if (!out.baseUrl) out.baseUrl = out.lifecycleBaseUrl;   // 5 Oct decision: one collection serves both
    return out;
  }

  function demoSheet_() {
    var ss = host_(), sh = ss.getSheetByName('demo_registry');
    if (!sh) { sh = ss.insertSheet('demo_registry'); sh.appendRow(HEADERS); sh.setFrozenRows(1); }
    return sh;
  }

  /** Record (dry run) or claim (live) a newly created workbook. */
  function recordCreated(args) {
    if (mode() === 'live') {
      var s = settings_();
      var claim = SDC.Registry.claim(s, { clientName: args.clientName, spreadsheetId: args.spreadsheetId,
                                          workbookUrl: args.url, correlationId: args.correlationId });
      var bound = SDC.Registry.applyToWorkbook(SpreadsheetApp.openById(args.spreadsheetId),
                                               { routerBaseUrl: s.baseUrl, workspaceKey: claim.workspace_key });
      return { mode: 'live', state: claim.state || 'bound', workspaceKey: claim.workspace_key, written: bound.written };
    }
    demoSheet_().appendRow([new Date().toISOString(), Session.getActiveUser().getEmail(), args.clientName,
                            args.spreadsheetId, args.url, 'created (not claimed)', '', args.correlationId || '']);
    return { mode: 'dry_run', state: 'created (not claimed)', workspaceKey: null };
  }

  function list() {
    if (mode() === 'live') return SDC.Registry.list(settings_()).workspaces || [];
    return demoSheet_().getDataRange().getValues().slice(1).reverse().map(function (r) {
      var o = {}; HEADERS.forEach(function (h, i) { o[h] = r[i]; }); return o;
    });
  }

  return { recordCreated: recordCreated, list: list, mode: mode };
})();
