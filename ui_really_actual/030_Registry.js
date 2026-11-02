/**
 * Registry — two records, kept apart on purpose.
 *
 *   workbooks (local tab in the routing workbook)   every config workbook the app generated: who, when, for which
 *                                                   client, and — once claimed — which workspace. The router has no
 *                                                   notion of an unclaimed workbook, so this is the only place one
 *                                                   is remembered. Replaces the earlier demo_registry tab.
 *   RTR_Pool (router, via SDC.Registry)             workspaces and their state; a workbook appears there only after claim.
 *
 * Create and claim are therefore separate actions: create always writes the local ledger; claim (live mode only)
 * runs the same sequence as "Claim workspace…" in Code.js — claim → applyToWorkbook(full binding) → migrate,
 * release on failure — and then stamps the ledger row. Everything the router owns goes through readSettings_,
 * SDC.Registry.* and refreshRegistry_ exactly as the menu does.
 *
 * REGISTRY_MODE=dry_run (default): the ledger works; every router call refuses with a plain message.
 * ACTIONS_BY_STATE decides which buttons the page shows, per the menu items' own explanations; the router is the
 * authority on legality.
 */
var Registry = (function () {

  var WORKBOOKS_SHEET = 'workbooks';
  var LEDGER = ['created_at', 'created_by', 'client_name', 'spreadsheet_id', 'workbook_url', 'correlation_id', 'workspace_key', 'claimed_at'];

  var ACTIONS_BY_STATE = {
    empty: ['prepare'], failed: ['prepare'],
    queued: [], deploying: [], configuring: [], registering: [],
    needs_connections: ['register'],
    available: [],                    // claim is a workbook-side action (see claim below)
    bound: ['release'],
    active: ['close'],
    inactive: ['release']
  };

  function host_() { return SpreadsheetApp.getActiveSpreadsheet(); }
  function mode()  { return PropertiesService.getScriptProperties().getProperty('REGISTRY_MODE') || 'dry_run'; }
  function liveOnly_(what) { if (mode() !== 'live') throw new Error(what + ' needs REGISTRY_MODE=live; the registry is in dry run.'); }

  // --- Local ledger ---------------------------------------------------------------------------------------------
  function ledger_() {
    var ss = host_(), sh = ss.getSheetByName(WORKBOOKS_SHEET);
    if (!sh) { sh = ss.insertSheet(WORKBOOKS_SHEET); sh.appendRow(LEDGER); sh.setFrozenRows(1); }
    return sh;
  }
  function ledgerRows_() {
    var data = ledger_().getDataRange().getValues();
    return data.slice(1).map(function (r, i) {
      var o = { _row: i + 2 }; LEDGER.forEach(function (h, k) { o[h] = r[k] instanceof Date ? r[k].toISOString() : r[k]; }); return o;
    });
  }
  function ledgerFind_(spreadsheetId) {
    return ledgerRows_().filter(function (r) { return r.spreadsheet_id === spreadsheetId; })[0] || null;
  }

  /** Called by createImplementation in both modes. Records the workbook; links nothing. */
  function recordCreated(args) {
    ledger_().appendRow([new Date().toISOString(), Session.getActiveUser().getEmail(), args.clientName,
                         args.spreadsheetId, args.url, args.correlationId || '', '', '']);
    return { state: 'created (not claimed)', workspaceKey: null };
  }

  /** Workbooks the app generated that no workspace has been claimed for, newest first. */
  function listUnclaimed() {
    return ledgerRows_().filter(function (r) { return !r.workspace_key; }).reverse();
  }

  // --- Claim: bind a created workbook to the first available workspace -----------------------------------------
  /**
   * @param {string} spreadsheetId  a workbook the app created, or any SDC config workbook (then client name is read from 1_customer)
   * @param {string} [correlationId]
   */
  function claim(spreadsheetId, correlationId) {
    liveOnly_('Claim');
    var ss = host_(), settings = readSettings_(ss);
    var cid = correlationId || SDC.Util.newCorrelationId();
    var log = SDC.Log.forCorrelation(ss, cid);

    var target = SpreadsheetApp.openById(spreadsheetId);
    if (!target.getSheetByName('_developer_settings')) throw new Error('"' + target.getName() + '" has no _developer_settings tab; it is not an SDC config workbook.');
    var entry = ledgerFind_(spreadsheetId);
    var clientName = entry && entry.client_name
      ? String(entry.client_name)
      : SDC.Customer.readOne(target, SDC.Config.build(target), 'clientName');
    if (!clientName) throw new Error('Client name is blank in 1_customer; fill it before claiming.');
    if (entry && entry.workspace_key) throw new Error('This workbook is already bound to ' + entry.workspace_key + '.');

    var result = SDC.Registry.claim(settings.registry, {
      clientName: clientName, spreadsheetId: spreadsheetId, workbookUrl: target.getUrl(), correlationId: cid
    });
    log('INFO', 'Claimed ' + result.workspace_key + ' for ' + clientName + ' (' + spreadsheetId + ') from the web app.');

    try {
      var applied = SDC.Registry.applyToWorkbook(target, {
        routerBaseUrl:           settings.workbook.routerBaseUrl,
        workspaceKey:            result.workspace_key,
        integrationAccountEmail: settings.workbook.integrationAccountEmail,
        configExportFolderId:    settings.workbook.configExportFolderId,
        authorizedEditors:       settings.workbook.authorizedEditors
      });
      if (SDC.Migrations.isMigrationNeeded(target)) {
        var mig = SDC.Migrations.run(target);
        if (!mig.ok) throw new Error('Workbook schema migration failed: ' + mig.message);
      }
      try { SDC.Log.append(target, 'SUCCESS', 'Bound to workspace ' + result.workspace_key + ' by the implementations app.', cid); } catch (ignore) {}
      log('SUCCESS', 'Bound ' + result.workspace_key + ' → ' + spreadsheetId + '; wrote ' + applied.written.join(', ') + '.');
    } catch (e) {
      log('ERROR', 'Settings write failed after claim; releasing ' + result.workspace_key + ': ' + e.message);
      var released = true;
      try { SDC.Registry.release(settings.registry, result.workspace_key, cid); }
      catch (e2) { released = false; log('ERROR', 'Release after failed claim also failed: ' + e2.message); }
      refreshRegistry_(ss, settings);
      throw new Error('Claim rolled back' + (released ? '' : ' (release ALSO failed — check ' + result.workspace_key + ' in the registry)') + ': ' + e.message);
    }

    // Stamp the ledger: the app's own row if it generated this workbook, otherwise a new row so it is tracked from now on.
    var sh = ledger_();
    if (!entry) { recordCreated({ clientName: clientName, spreadsheetId: spreadsheetId, url: target.getUrl(), correlationId: cid }); entry = { _row: sh.getLastRow() }; }
    sh.getRange(entry._row, LEDGER.indexOf('workspace_key') + 1, 1, 2).setValues([[result.workspace_key, new Date().toISOString()]]);
    refreshRegistry_(ss, settings);
    return { state: result.state || 'bound', workspaceKey: result.workspace_key, written: applied.written, correlationId: cid };
  }

  // --- Router reads -----------------------------------------------------------------------------------------------
  function list() {
    if (mode() !== 'live') return [];
    var rows = SDC.Registry.list(readSettings_(host_()).registry).workspaces || [];
    return rows.map(function (r) { return Object.assign({}, r, { _actions: ACTIONS_BY_STATE[String(r.state || '')] || [] }); });
  }
  function status(workspaceKey) {
    liveOnly_('Status');
    return SDC.Registry.status(readSettings_(host_()).registry, workspaceKey);
  }

  // --- Lifecycle: the same cycle as lifecycleAction_ in Code.js, without the prompts --------------------------------
  function action(op, workspaceKey) {
    liveOnly_(op);
    if (['prepare', 'register', 'release', 'close'].indexOf(op) < 0) throw new Error('Unknown action: ' + op);
    var ss = host_(), settings = readSettings_(ss);
    var cid = SDC.Util.newCorrelationId();
    var log = SDC.Log.forCorrelation(ss, cid);
    try {
      var result = SDC.Registry[op](settings.registry, workspaceKey, cid);
      log('SUCCESS', op + ' ' + workspaceKey + ': ' + JSON.stringify(result).substring(0, 300));
      if (op === 'release') {   // the binding is gone on the router side; reflect it locally
        ledgerRows_().filter(function (r) { return r.workspace_key === workspaceKey; })
          .forEach(function (r) { ledger_().getRange(r._row, LEDGER.indexOf('workspace_key') + 1, 1, 2).setValues([['', '']]); });
      }
      refreshRegistry_(ss, settings);
      return { action: op, workspaceKey: workspaceKey, correlationId: cid, result: result };
    } catch (e) {
      log('ERROR', op + ' ' + workspaceKey + ' failed: ' + e.message);
      throw e;
    }
  }

  return { recordCreated: recordCreated, listUnclaimed: listUnclaimed, claim: claim, list: list, status: status, action: action, mode: mode };
})();
