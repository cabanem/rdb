/**
 * @file 013_Registry.gs
 * Workspace registry client. The registry is the router's RTR_Pool table in Workato; this module is the only
 * place that knows the lifecycle endpoints, so the routing workbook's shim stays as thin as a config workbook's.
 *
 * One workspace row, one state at a time:
 *   pool (ops):        empty → queued → deploying → configuring → needs_connections → registering → available
 *   engagement:        available → bound → active → inactive        (failed is a side state)
 * Writers: prepare/register (POOL-01) own the pool states; Registry.claim writes bound; the router writes active
 * (first successful /provision); Registry.close writes inactive; Registry.release returns bound/inactive to available.
 *
 * Endpoints (Workspace lifecycle collection, router API token):
 *   GET  /workspaces                         list
 *   GET  /workspaces/{key}/status            one row
 *   POST /workspaces/prepare                 {workspace_key, correlation_id}           → 202 job
 *   POST /workspaces/register                {workspace_key, correlation_id}           → 202 job
 *   POST /workspaces/claim                   {client_name, spreadsheet_id, workbook_url, correlation_id} → 200 {workspace_key}
 *   POST /workspaces/{key}/release           {correlation_id}
 *   POST /workspaces/{key}/close             {correlation_id}
 *
 * Every call returns the parsed body on 2xx and throws an Error carrying statusCode / errorCode otherwise, using
 * the same error_details envelope the router and the workspaces use.
 *
 * Public:
 *   Registry.list(settings)                                  → { workspaces: [...] }
 *   Registry.status(settings, workspaceKey)                  → row
 *   Registry.prepare(settings, workspaceKey, correlationId)  → job
 *   Registry.register(settings, workspaceKey, correlationId) → job
 *   Registry.claim(settings, args)                           → { workspace_key, state, ... }
 *   Registry.release(settings, workspaceKey, correlationId)  → row
 *   Registry.close(settings, workspaceKey, correlationId)    → row
 *   Registry.applyToWorkbook(targetSs, binding)              → { written: [...] }
 *
 *   settings = { lifecycleBaseUrl, apiToken }   (read from the routing workbook's _settings by the shim)
 */

var Registry = {};

Registry.list = function(settings) {
  return Registry._call(settings, 'get', '/workspaces', null);
};

Registry.status = function(settings, workspaceKey) {
  return Registry._call(settings, 'get', '/workspaces/' + Registry._key(workspaceKey) + '/status', null);
};

Registry.prepare = function(settings, workspaceKey, correlationId) {
  return Registry._call(settings, 'post', '/workspaces/prepare',
    { workspace_key: Registry._key(workspaceKey), correlation_id: correlationId || Util.newCorrelationId() });
};

Registry.register = function(settings, workspaceKey, correlationId) {
  return Registry._call(settings, 'post', '/workspaces/register',
    { workspace_key: Registry._key(workspaceKey), correlation_id: correlationId || Util.newCorrelationId() });
};

/**
 * Claim the first available workspace for a config workbook. The router serialises claims (the endpoint recipe
 * runs at concurrency 1), so two analysts claiming at once get two different rows.
 *
 * @param {Object} settings
 * @param {Object} args  { clientName, spreadsheetId, workbookUrl, [correlationId] }
 */
Registry.claim = function(settings, args) {
  if (!args || !args.clientName)    throw new Error('Registry.claim: clientName is required.');
  if (!args.spreadsheetId)          throw new Error('Registry.claim: spreadsheetId is required.');
  return Registry._call(settings, 'post', '/workspaces/claim', {
    client_name:    String(args.clientName).trim(),
    spreadsheet_id: String(args.spreadsheetId).trim(),
    workbook_url:   args.workbookUrl || ('https://docs.google.com/spreadsheets/d/' + args.spreadsheetId),
    correlation_id: args.correlationId || Util.newCorrelationId()
  });
};

Registry.release = function(settings, workspaceKey, correlationId) {
  return Registry._call(settings, 'post', '/workspaces/' + Registry._key(workspaceKey) + '/release',
    { correlation_id: correlationId || Util.newCorrelationId() });
};

Registry.close = function(settings, workspaceKey, correlationId) {
  return Registry._call(settings, 'post', '/workspaces/' + Registry._key(workspaceKey) + '/close',
    { correlation_id: correlationId || Util.newCorrelationId() });
};

/**
 * Write the binding into a config workbook's _developer_settings. Upserts by (category, key); never deletes.
 * These are the only per-workbook settings routing needs; the router URL and token are the same for every workbook.
 *
 * @param {Spreadsheet} targetSs
 * @param {Object} binding  { routerBaseUrl, routerApiToken, workspaceKey,
 *                            [integrationAccountEmail], [configExportFolderId], [authorizedEditors] }
 *                          Optional keys are written only when non-blank, so a bound workbook keeps its own values.
 * @returns {{written: string[]}}
 */
Registry.applyToWorkbook = function(targetSs, binding) {
  if (!targetSs) throw new Error('Registry.applyToWorkbook: targetSs is required.');
  if (!binding || !binding.routerBaseUrl || !binding.routerApiToken || !binding.workspaceKey) {
    throw new Error('Registry.applyToWorkbook: routerBaseUrl, routerApiToken and workspaceKey are required.');
  }
  var devSheet = targetSs.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("'_developer_settings' tab is missing from " + targetSs.getName() +
      '. This is not an SDC config workbook (or the tab was renamed).');
  }

  // Row layout follows the _developer_settings convention the library reads: A unused, B category, C key, D value,
  // E description.
  var rows = [
    ['router',  'baseUrl',       binding.routerBaseUrl,  'SDC router collection base URL. Written on claim.'],
    ['router',  'apiToken',      binding.routerApiToken, 'SDC router API token. Written on claim.'],
    ['meta',    'workspace_key', binding.workspaceKey,   'Client workspace this workbook is bound to (traceability only).']
  ];
  if (binding.integrationAccountEmail) rows.push(['sharing', 'integrationAccountEmail', binding.integrationAccountEmail, '']);
  if (binding.configExportFolderId)    rows.push(['storage', 'configExportFolderId',    binding.configExportFolderId,    '']);
  if (binding.authorizedEditors)       rows.push(['sharing', 'authorizedEditors',       binding.authorizedEditors,       '']);

  var data = devSheet.getDataRange().getValues();
  var written = [];
  rows.forEach(function(r) {
    var category = r[0], key = r[1], value = r[2], description = r[3];
    for (var i = 0; i < data.length; i++) {
      if (data[i][1] === category && data[i][2] === key) {
        devSheet.getRange(i + 1, 4).setValue(value);
        written.push(category + '.' + key);
        return;
      }
    }
    devSheet.appendRow(['', category, key, value, description]);
    data.push(['', category, key, value, description]);
    written.push(category + '.' + key + ' (new row)');
  });
  return { written: written };
};

// --- Private helpers -------------------------------------------------

Registry._key = function(workspaceKey) {
  var k = String(workspaceKey || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(k)) {
    throw new Error('Registry: "' + k + '" is not a valid workspace key (lowercase letters, digits and hyphens).');
  }
  return k;
};

Registry._call = function(settings, method, path, body) {
  if (!settings || !settings.lifecycleBaseUrl) throw new Error('Registry: settings.lifecycleBaseUrl is required (_settings → router.lifecycleBaseUrl).');
  if (!settings.apiToken)                       throw new Error('Registry: settings.apiToken is required (_settings → router.apiToken).');

  var url = settings.lifecycleBaseUrl.replace(/\/+$/, '') + path;
  var options = {
    method:             method,
    headers:            { 'API-TOKEN': settings.apiToken },
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  var resp   = UrlFetchApp.fetch(url, options);
  var status = resp.getResponseCode();
  var text   = resp.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(text); } catch (e) {}

  if (status >= 200 && status < 300) return parsed || {};

  var d = parsed && parsed.error_details;
  var msg = d ? ((d.code ? '[' + d.code + '] ' : '') + (d.error_message || '')) : String(text || '').substring(0, 300);
  if (status === 401) msg += ' (router API token rejected; check _settings → router.apiToken)';
  if (status === 404 && !d) msg += ' (no such endpoint; check _settings → router.lifecycleBaseUrl)';
  var err = new Error('Registry ' + method.toUpperCase() + ' ' + path + ' → HTTP ' + status + ': ' + msg);
  err.statusCode = status;
  err.errorCode  = d && d.code ? d.code : null;
  throw err;
};
