/**
 * @file main.gs (container-bound) — SDC routing workbook
 *
 * Thin UI over SDC.Registry. The workbook holds no state of its own: `registry` is a read-only view of the
 * router's RTR_Pool table, refreshed on demand; `_settings` holds the router credentials and the defaults a new
 * config workbook needs; `_script_logs` is the usual SDC log sheet.
 *
 * Tabs
 *   registry       view: workspace_key | state | client_name | spreadsheet_id | workbook_url | bound_at |
 *                        activated_at | closed_at | api_base_url | last_error | pending_connections | updated_at
 *   _settings      A=description, B=category, C=key, D=value (same convention as _developer_settings):
 *                    router.baseUrl             Route collection base URL (…/router-v1); written into claimed workbooks
 *                    router.lifecycleBaseUrl    Workspace lifecycle collection base URL (…/workspace_lifecycles)
 *                    router.apiToken            router API client token (one client, both collections)
 *                    template.workbookId        config workbook template to copy on "generate"
 *                    template.destinationFolderId  where generated workbooks land
 *                    workbook.integrationAccountEmail  default sharing.integrationAccountEmail for new workbooks
 *                    workbook.configExportFolderId     default storage.configExportFolderId (blank = leave as is)
 *                    workbook.authorizedEditors        default sharing.authorizedEditors   (blank = leave as is)
 *   _script_logs   SDC.Log
 *
 * Library identifier: SDC.
 */

var REGISTRY_SHEET = 'registry';
var SETTINGS_SHEET = '_settings';
var REGISTRY_COLUMNS = [
  'workspace_key', 'state', 'client_name', 'spreadsheet_id', 'workbook_url', 'bound_at', 'activated_at',
  'closed_at', 'api_base_url', 'last_error', 'pending_connections', 'updated_at'
];

// --- Menu ------------------------------------------------------------

function onOpen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  SDC.Log.ensureSchema(ss);

  var ops = ui.createMenu('Pool (ops)')
    .addItem('Prepare workspace…',   'prepareWorkspace')
    .addItem('Register workspace…',  'registerWorkspace')
    .addItem('Check workspace…',     'checkWorkspace');

  ui.createMenu('Workspace routing')
    .addItem('Claim workspace…',     'claimWorkspace')
    .addItem('Refresh registry',     'refreshRegistry')
    .addSeparator()
    .addItem('Close engagement…',    'closeEngagement')
    .addItem('Release workspace…',   'releaseWorkspace')
    .addSeparator()
    .addSubMenu(ops)
    .addToUi();
}

// --- Engagement lifecycle -------------------------------------------

/**
 * Claim: pick the first available workspace, bind it to a config workbook (existing or generated from the
 * template), write the router settings into that workbook. Claim first, then write, so a failed write can give
 * the workspace back.
 */
function claimWorkspace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var settings = readSettings_(ss);
  var correlationId = SDC.Util.newCorrelationId();
  var log = SDC.Log.forCorrelation(ss, correlationId);

  var clientName = prompt_(ui, 'Claim workspace', 'Client name:');
  if (clientName === null) return;
  if (!clientName) { ui.alert('Client name is required.'); return; }

  var existing = prompt_(ui, 'Claim workspace',
    'Config workbook to bind — paste its URL or ID.\nLeave blank to generate a new workbook from the template.');
  if (existing === null) return;

  var target, generated = false;
  try {
    if (existing) {
      target = SpreadsheetApp.openById(extractSpreadsheetId_(existing));
    } else {
      var name = prompt_(ui, 'Claim workspace', 'Name for the new config workbook:', clientName + ' - SDC configuration');
      if (name === null) return;
      target = generateWorkbook_(settings, name || (clientName + ' - SDC configuration'));
      generated = true;
      log('INFO', 'Generated config workbook "' + target.getName() + '" (' + target.getId() + ').');
    }
    if (!target.getSheetByName('_developer_settings')) {
      throw new Error('"' + target.getName() + '" has no _developer_settings tab; it is not an SDC config workbook.');
    }
  } catch (e) {
    log('ERROR', 'Claim aborted before the registry was touched: ' + e.message);
    ui.alert('Claim failed', e.message, ui.ButtonSet.OK);
    return;
  }

  var claim;
  try {
    ss.toast('Claiming a workspace for ' + clientName + '…', 'Status');
    claim = SDC.Registry.claim(settings.registry, {
      clientName: clientName, spreadsheetId: target.getId(), workbookUrl: target.getUrl(), correlationId: correlationId
    });
    log('INFO', 'Claimed ' + claim.workspace_key + ' for ' + clientName + ' (' + target.getId() + ').');
  } catch (e) {
    log('ERROR', 'Claim failed: ' + e.message);
    ui.alert('Claim failed', e.message + (generated ? '\n\nThe generated workbook was kept: ' + target.getUrl() : ''), ui.ButtonSet.OK);
    return;
  }

  try {
    var applied = SDC.Registry.applyToWorkbook(target, {
      routerBaseUrl:           settings.workbook.routerBaseUrl,
      routerApiToken:          settings.registry.apiToken,
      workspaceKey:            claim.workspace_key,
      integrationAccountEmail: settings.workbook.integrationAccountEmail,
      configExportFolderId:    settings.workbook.configExportFolderId,
      authorizedEditors:       settings.workbook.authorizedEditors
    });
    if (SDC.Migrations.isMigrationNeeded(target)) {
      var mig = SDC.Migrations.run(target);
      if (!mig.ok) throw new Error('Workbook schema migration failed: ' + mig.message);
      log('INFO', 'Migrated "' + target.getName() + '" to schema ' + SDC.Version.SCHEMA + '.');
    }
    log('SUCCESS', 'Bound ' + claim.workspace_key + ' → ' + target.getId() + '; wrote ' + applied.written.join(', ') + '.');
  } catch (e) {
    // Compensate: the workspace is bound to a workbook that cannot reach the router. Give it back.
    log('ERROR', 'Settings write failed after claim; releasing ' + claim.workspace_key + ': ' + e.message);
    try { SDC.Registry.release(settings.registry, claim.workspace_key, correlationId); }
    catch (e2) { log('ERROR', 'Release after failed claim also failed: ' + e2.message); }
    ui.alert('Claim rolled back', e.message, ui.ButtonSet.OK);
    return;
  }

  refreshRegistry_(ss, settings);
  ss.toast('');
  ui.alert('Workspace claimed',
    clientName + ' → ' + claim.workspace_key + '\n\nConfig workbook:\n' + target.getUrl() +
    '\n\nThe analyst can now open it and run "Start supplier data collection".', ui.ButtonSet.OK);
}

function closeEngagement() {
  lifecycleAction_('Close engagement', 'close',
    'Marks the engagement finished (active → inactive). The workbook can no longer send to this workspace.');
}

function releaseWorkspace() {
  lifecycleAction_('Release workspace', 'release',
    'Returns the workspace to the pool (bound or inactive → available) and clears its binding.\n' +
    'For an inactive workspace, confirm the client data has been purged first.');
}

// --- Pool lifecycle (ops) -------------------------------------------

function prepareWorkspace() {
  lifecycleAction_('Prepare workspace', 'prepare',
    'Deploys the golden estate into this workspace (empty → … → needs_connections). Runs in the background; ' +
    'use "Check workspace…" to follow it.');
}

function registerWorkspace() {
  lifecycleAction_('Register workspace', 'register',
    'Creates the API client in the workspace, stores its token in the router, health-checks it (needs_connections → available). ' +
    'Authorise the pending connections in the workspace first.');
}

function checkWorkspace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var settings = readSettings_(ss);
  var key = prompt_(ui, 'Check workspace', 'Workspace key:');
  if (!key) return;
  try {
    var row = SDC.Registry.status(settings.registry, key);
    var pending = row.pending_connections ? '\nPending connections: ' + JSON.stringify(row.pending_connections) : '';
    var job = row.last_job ? '\nLast job: ' + JSON.stringify(row.last_job) : '';
    ui.alert(key, 'State: ' + row.state + '\nAPI base URL: ' + (row.api_base_url || '—') + pending + job, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Check failed', e.message, ui.ButtonSet.OK);
  }
}

function refreshRegistry() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    var n = refreshRegistry_(ss, readSettings_(ss));
    ss.toast('Registry refreshed: ' + n + ' workspace(s).', 'Status');
  } catch (e) {
    SpreadsheetApp.getUi().alert('Refresh failed', e.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

// --- Helpers ---------------------------------------------------------

/** One prompt-confirm-call-refresh cycle for the key-addressed lifecycle actions. */
function lifecycleAction_(title, op, explanation) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var settings = readSettings_(ss);
  var key = prompt_(ui, title, explanation + '\n\nWorkspace key:');
  if (!key) return;
  var correlationId = SDC.Util.newCorrelationId();
  var log = SDC.Log.forCorrelation(ss, correlationId);
  try {
    ss.toast(title + ' ' + key + '…', 'Status');
    var result = SDC.Registry[op](settings.registry, key, correlationId);
    log('SUCCESS', title + ' ' + key + ': ' + JSON.stringify(result).substring(0, 300));
    refreshRegistry_(ss, settings);
    ss.toast('');
    ui.alert(title, key + ' → ' + (result.state || 'accepted') + (result.job_id ? '\nJob ' + result.job_id : ''), ui.ButtonSet.OK);
  } catch (e) {
    log('ERROR', title + ' ' + key + ' failed: ' + e.message);
    ss.toast('');
    ui.alert(title + ' failed', e.message, ui.ButtonSet.OK);
  }
}

/** Rewrite the `registry` view from GET /workspaces. Returns the row count. */
function refreshRegistry_(ss, settings) {
  var body = SDC.Registry.list(settings.registry);
  var rows = (body.workspaces || []).map(function(w) {
    return REGISTRY_COLUMNS.map(function(c) {
      var v = w[c];
      return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
    });
  });
  var sheet = ss.getSheetByName(REGISTRY_SHEET) || ss.insertSheet(REGISTRY_SHEET);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, REGISTRY_COLUMNS.length).setValues([REGISTRY_COLUMNS]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, REGISTRY_COLUMNS.length).setValues(rows);
  sheet.setFrozenRows(1);
  return rows.length;
}

/** Copy the template workbook into the destination folder. */
function generateWorkbook_(settings, name) {
  if (!settings.template.workbookId) throw new Error('_settings → template.workbookId is not set; cannot generate a workbook.');
  var template = DriveApp.getFileById(settings.template.workbookId);
  var folder = settings.template.destinationFolderId
    ? DriveApp.getFolderById(settings.template.destinationFolderId)
    : DriveApp.getRootFolder();
  var copy = template.makeCopy(name, folder);
  return SpreadsheetApp.openById(copy.getId());
}

/** Read _settings (same 4-column convention as _developer_settings) into the shapes Registry wants. */
function readSettings_(ss) {
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) throw new Error("'" + SETTINGS_SHEET + "' tab is missing from the routing workbook.");
  var data = sheet.getDataRange().getValues();
  var get = function(category, key) {
    var row = data.find(function(r) { return r[1] === category && r[2] === key; });
    return row ? String(row[3] === null || row[3] === undefined ? '' : row[3]).trim() : '';
  };
  var s = {
    registry: { lifecycleBaseUrl: get('router', 'lifecycleBaseUrl'), apiToken: get('router', 'apiToken') },
    workbook: {
      routerBaseUrl:           get('router',   'baseUrl'),
      integrationAccountEmail: get('workbook', 'integrationAccountEmail'),
      configExportFolderId:    get('workbook', 'configExportFolderId'),
      authorizedEditors:       get('workbook', 'authorizedEditors')
    },
    template: { workbookId: get('template', 'workbookId'), destinationFolderId: get('template', 'destinationFolderId') }
  };
  var missing = [];
  if (!s.registry.lifecycleBaseUrl) missing.push('router.lifecycleBaseUrl');
  if (!s.registry.apiToken)         missing.push('router.apiToken');
  if (!s.workbook.routerBaseUrl)    missing.push('router.baseUrl');
  if (missing.length) throw new Error('_settings is missing: ' + missing.join(', ') + '.');
  return s;
}

function prompt_(ui, title, text, defaultValue) {
  var r = ui.prompt(title, text, ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  var v = String(r.getResponseText() || '').trim();
  return v || (defaultValue || '');
}

function extractSpreadsheetId_(s) {
  var m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : String(s).trim();
}
