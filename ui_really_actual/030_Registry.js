/**
 * Registry — the implementation / workspace record, as the routing workbook already models it.
 *
 * Everything here mirrors Code.js in app_sdc-router:
 *   settings            readSettings_(ss).registry  ({lifecycleBaseUrl, apiToken}) and .workbook (binding defaults)
 *   claim               claim → applyToWorkbook(full binding) → migrate; on failure release (claimWorkspace's compensation)
 *   list / status       SDC.Registry.list / status; row columns per REGISTRY_COLUMNS, plus last_job on status
 *   prepare / register  pool (ops) actions, 202 jobs — follow with status
 *   release / close     engagement actions
 *   refreshRegistry_    the routing workbook's `registry` view is rewritten after every write, as the menu does
 *
 * REGISTRY_MODE=dry_run (default): list reads a `demo_registry` tab; recordCreated appends there; every router
 * call refuses with a plain message. REGISTRY_MODE=live: the real thing. The router is the authority on legal
 * transitions; ACTIONS_BY_STATE only decides which buttons the page shows, per the menu items' own explanations:
 *   prepare   empty → … → needs_connections         register  needs_connections → available
 *   close     active → inactive                      release   bound | inactive → available
 */
var Registry = (function () {

  var DEMO_HEADERS = ['workspace_key', 'state', 'client_name', 'spreadsheet_id', 'workbook_url', 'bound_at', 'updated_at', 'created_by', 'correlation_id'];

  var ACTIONS_BY_STATE = {
    empty: ['prepare'], failed: ['prepare'],
    queued: [], deploying: [], configuring: [], registering: [],
    needs_connections: ['register'],
    available: [],                    // claim happens through the kickoff form
    bound: ['release'],
    active: ['close'],
    inactive: ['release']
  };

  function host_() { return SpreadsheetApp.getActiveSpreadsheet(); }
  function mode()  { return PropertiesService.getScriptProperties().getProperty('REGISTRY_MODE') || 'dry_run'; }
  function liveOnly_(what) { if (mode() !== 'live') throw new Error(what + ' needs REGISTRY_MODE=live; the registry is in dry run.'); }

  function demoSheet_() {
    var ss = host_(), sh = ss.getSheetByName('demo_registry');
    if (!sh) { sh = ss.insertSheet('demo_registry'); sh.appendRow(DEMO_HEADERS); sh.setFrozenRows(1); }
    return sh;
  }

  // --- Kickoff: claim, bind, compensate -------------------------------------------------------------------------
  /**
   * @param {Object} args { spreadsheetId, url, clientName, correlationId }
   * @return {Object} { mode, state, workspaceKey, written?, note? }
   */
  function recordCreated(args) {
    var ss = host_();
    if (mode() !== 'live') {
      demoSheet_().appendRow(['', 'created (not claimed)', args.clientName, args.spreadsheetId, args.url, '',
                              new Date().toISOString(), Session.getActiveUser().getEmail(), args.correlationId || '']);
      return { mode: 'dry_run', state: 'created (not claimed)', workspaceKey: null };
    }

    var settings = readSettings_(ss);
    var log = SDC.Log.forCorrelation(ss, args.correlationId);
    var claim = SDC.Registry.claim(settings.registry, {
      clientName: args.clientName, spreadsheetId: args.spreadsheetId, workbookUrl: args.url, correlationId: args.correlationId
    });
    log('INFO', 'Claimed ' + claim.workspace_key + ' for ' + args.clientName + ' (' + args.spreadsheetId + ') from the web app.');

    try {
      var target = SpreadsheetApp.openById(args.spreadsheetId);
      var applied = SDC.Registry.applyToWorkbook(target, {
        routerBaseUrl:           settings.workbook.routerBaseUrl,
        workspaceKey:            claim.workspace_key,
        integrationAccountEmail: settings.workbook.integrationAccountEmail,
        configExportFolderId:    settings.workbook.configExportFolderId,
        authorizedEditors:       settings.workbook.authorizedEditors
      });
      if (SDC.Migrations.isMigrationNeeded(target)) {
        var mig = SDC.Migrations.run(target);
        if (!mig.ok) throw new Error('Workbook schema migration failed: ' + mig.message);
      }
      log('SUCCESS', 'Bound ' + claim.workspace_key + ' → ' + args.spreadsheetId + '; wrote ' + applied.written.join(', ') + '.');
      refreshRegistry_(ss, settings);
      return { mode: 'live', state: claim.state || 'bound', workspaceKey: claim.workspace_key, written: applied.written };
    } catch (e) {
      log('ERROR', 'Settings write failed after claim; releasing ' + claim.workspace_key + ': ' + e.message);
      var released = true;
      try { SDC.Registry.release(settings.registry, claim.workspace_key, args.correlationId); }
      catch (e2) { released = false; log('ERROR', 'Release after failed claim also failed: ' + e2.message); }
      refreshRegistry_(ss, settings);
      throw new Error('Claim rolled back' + (released ? '' : ' (release ALSO failed — check ' + claim.workspace_key + ' in the registry)') + ': ' + e.message);
    }
  }

  // --- Reads ------------------------------------------------------------------------------------------------------
  function list() {
    var rows;
    if (mode() === 'live') {
      rows = SDC.Registry.list(readSettings_(host_()).registry).workspaces || [];
    } else {
      rows = demoSheet_().getDataRange().getValues().slice(1).reverse().map(function (r) {
        var o = {}; DEMO_HEADERS.forEach(function (h, i) { o[h] = r[i]; }); return o;
      });
    }
    return rows.map(function (r) { return Object.assign({}, r, { _actions: ACTIONS_BY_STATE[String(r.state || '')] || [] }); });
  }

  function status(workspaceKey) {
    liveOnly_('Status');
    return SDC.Registry.status(readSettings_(host_()).registry, workspaceKey);
  }

  // --- Lifecycle: the same prompt-free cycle as lifecycleAction_ in Code.js ----------------------------------------
  function action(op, workspaceKey) {
    liveOnly_(op);
    if (!SDC.Registry[op] || ['prepare', 'register', 'release', 'close'].indexOf(op) < 0) throw new Error('Unknown action: ' + op);
    var ss = host_(), settings = readSettings_(ss);
    var cid = SDC.Util.newCorrelationId();
    var log = SDC.Log.forCorrelation(ss, cid);
    try {
      var result = SDC.Registry[op](settings.registry, workspaceKey, cid);
      log('SUCCESS', op + ' ' + workspaceKey + ': ' + JSON.stringify(result).substring(0, 300));
      refreshRegistry_(ss, settings);
      return { action: op, workspaceKey: workspaceKey, correlationId: cid, result: result };
    } catch (e) {
      log('ERROR', op + ' ' + workspaceKey + ' failed: ' + e.message);
      throw e;
    }
  }

  return { recordCreated: recordCreated, list: list, status: status, action: action, mode: mode };
})();
