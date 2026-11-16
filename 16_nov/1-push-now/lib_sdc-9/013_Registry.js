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
 *   POST /workspaces/claim                   {client_name, spreadsheet_id, workbook_url, correlation_id,
 *                                             [analyst_email], [analyst_name]}
 *                                            → 200 {workspace_key, state, …, invite: {attempted, status, message}}
 *   POST /workspaces/{key}/release           {correlation_id}
 *   POST /workspaces/{key}/close             {correlation_id}
 *   POST /workspaces/{key}/clean             {correlation_id, dry_run}                 → 202 job
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
 *   Registry.clean(settings, workspaceKey, correlationId, {dryRun})  → job
 *   Registry.applyToWorkbook(targetSs, binding)              → { written: [...] }
 *   Registry.settingsFromProperties()                        → settings, from the library's Script Properties
 *   Registry.link(ss, {correlationId})                       → Result (flow 'link'): claim + applyToWorkbook for ss itself
 *
 *   settings = { lifecycleBaseUrl, apiToken }   — from the routing workbook's _settings (ops), or from the library's
 *   Script Properties SDC_ROUTER_BASE_URL / SDC_ROUTER_API_TOKEN (a config workbook linking itself; the router address
 *   and token are constants of the estate, so no workbook has to carry them before it is bound).
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
 * @param {Object} args  { clientName, spreadsheetId, workbookUrl, [correlationId], [analystEmail], [analystName] }
 *                       analystEmail, when given, has the router invite that user to the claimed workspace as a
 *                       collaborator; the outcome comes back as `invite: {attempted, status, message}`.
 */
Registry.claim = function(settings, args) {
  if (!args || !args.clientName)    throw new Error('Registry.claim: clientName is required.');
  if (!args.spreadsheetId)          throw new Error('Registry.claim: spreadsheetId is required.');
  var body = {
    client_name:    String(args.clientName).trim(),
    spreadsheet_id: String(args.spreadsheetId).trim(),
    workbook_url:   args.workbookUrl || ('https://docs.google.com/spreadsheets/d/' + args.spreadsheetId),
    correlation_id: args.correlationId || Util.newCorrelationId()
  };
  if (args.analystEmail) body.analyst_email = String(args.analystEmail).trim();
  if (args.analystName)  body.analyst_name  = String(args.analystName).trim();
  return Registry._call(settings, 'post', '/workspaces/claim', body);
};

/**
 * Release a workspace. Once release runs the reset (POOL-API-06 calls the workspace's API-05 and answers when
 * it returns), this call can run for minutes, so it asks UrlFetchApp to wait the way Provision does. A timeout here
 * is NOT a result: the router finishes on its own and writes `available` or `needs_clean`. Re-read the row.
 */
Registry.RELEASE_TIMEOUT_SECONDS = 250;

Registry.release = function(settings, workspaceKey, correlationId) {
  return Registry._call(settings, 'post', '/workspaces/' + Registry._key(workspaceKey) + '/release',
    { correlation_id: correlationId || Util.newCorrelationId() },
    { fetchTimeoutSeconds: Registry.RELEASE_TIMEOUT_SECONDS });
};

/**
 * Clean a workspace: return it to `empty` by deleting its SDC project and API client (POOL-08 enqueues; POOL-01 /
 * POOL-15 do the work). Asynchronous — the router answers 202 with the job; follow it with Registry.status.
 * Legality is the router's: needs_clean, and ad hoc from available / needs_connections / failed. bound, active and
 * inactive are refused (release first).
 *
 * @param {Object}  settings
 * @param {string}  workspaceKey
 * @param {string}  [correlationId]
 * @param {Object}  [opts]           { dryRun: boolean } — inventory what would be deleted, delete nothing
 * @returns {Object} { job_id, workspace_key, command: 'clean', state, correlation_id, started_at }
 */
Registry.clean = function(settings, workspaceKey, correlationId, opts) {
  return Registry._call(settings, 'post', '/workspaces/' + Registry._key(workspaceKey) + '/clean',
    { correlation_id: correlationId || Util.newCorrelationId(), dry_run: !!(opts && opts.dryRun) });
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
 * @param {Object} binding  { routerBaseUrl, workspaceKey,
 *                            [integrationAccountEmail], [configExportFolderId], [authorizedEditors] }
 *                          Optional keys are written only when non-blank, so a bound workbook keeps its own values.
 * @returns {{written: string[]}}
 */
Registry.applyToWorkbook = function(targetSs, binding) {
  if (!targetSs) throw new Error('Registry.applyToWorkbook: targetSs is required.');
  if (!binding || !binding.routerBaseUrl || !binding.workspaceKey) {
    throw new Error('Registry.applyToWorkbook: routerBaseUrl and workspaceKey are required.');
  }
  var devSheet = targetSs.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("'_developer_settings' tab is missing from " + targetSs.getName() +
      '. This is not an SDC config workbook (or the tab was renamed).');
  }

  var rows = [
    ['SDC router collection base URL. Written on claim.',               'router',  'baseUrl',                 binding.routerBaseUrl],
    ['Client workspace this workbook is bound to (traceability only).', 'meta',    'workspace_key',           binding.workspaceKey]
  ];
  if (binding.integrationAccountEmail) rows.push(['', 'sharing', 'integrationAccountEmail', binding.integrationAccountEmail]);
  if (binding.configExportFolderId)    rows.push(['', 'storage', 'configExportFolderId',    binding.configExportFolderId]);
  if (binding.authorizedEditors)       rows.push(['', 'sharing', 'authorizedEditors',       binding.authorizedEditors]);

  var data = devSheet.getDataRange().getValues();
  var written = [];
  rows.forEach(function(r) {
    var category = r[1], key = r[2], value = r[3];
    for (var i = 0; i < data.length; i++) {
      if (data[i][1] === category && data[i][2] === key) {
        devSheet.getRange(i + 1, 4).setValue(value);
        written.push(category + '.' + key);
        return;
      }
    }
    devSheet.appendRow(['', category, key, value, r[0]]); // r[0] is the description field here
    data.push([r[0], category, key, value]);
    written.push(category + '.' + key + ' (new row)');
  });
  return { written: written };
};

/**
 * Registry settings for a config workbook that has no binding yet. Reads the library's own Script Properties under
 * the consumer's identity — the same mechanism Config.build already uses for the router token.
 *
 * @returns {{lifecycleBaseUrl: string, apiToken: string}}
 */
Registry.PROP_BASE_URL  = 'SDC_ROUTER_BASE_URL';
Registry.PROP_API_TOKEN = 'SDC_ROUTER_API_TOKEN';

Registry.settingsFromProperties = function() {
  var baseUrl = Config._secret(Registry.PROP_BASE_URL);
  var token   = Config._secret(Registry.PROP_API_TOKEN);
  var missing = [];
  if (!baseUrl) missing.push(Registry.PROP_BASE_URL);
  if (!token)   missing.push(Registry.PROP_API_TOKEN);
  if (missing.length) {
    throw new Error('lib_sdc Script Properties missing: ' + missing.join(', ') + '. Ops sets these once on the library project.');
  }
  return { lifecycleBaseUrl: baseUrl, apiToken: token };
};

/**
 * Link THIS workbook to a workspace: claim through the router, then write the binding into _developer_settings.
 * The same two calls the routing workbook makes (claim + applyToWorkbook), with the same rollback: if the settings
 * write fails after the claim succeeded, the workspace is released again.
 *
 * Needs a client name in 1_customer (the claim records it). The analyst email from 1_customer, or the running user
 * when that is blank (an analyst linking their own workbook is the analyst), goes with the claim so the router invites
 * them to the workspace; the outcome comes back in data.invite.
 *
 * Stages (Result.error.stage): already-linked, customer, settings, claim, apply (rolled back), apply-release-failed.
 *
 * @param {Spreadsheet} ss
 * @param {Object} [opts]  { correlationId }
 * @returns {Object} Result, flow 'link'. data = { workspaceKey, state, analystEmail, invite: {attempted, status, message},
 *                   written: string[] }
 */
Registry.link = function(ss, opts) {
  opts = opts || {};
  var correlationId = opts.correlationId || Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  var warnings = [];
  var fail = function(stage, message) {
    log('ERROR', 'Link failed at ' + stage + ': ' + message);
    var err = new Error(message); err.stage = stage;
    return Result.fail({ flow: 'link', correlationId: correlationId, message: message, error: err, warnings: warnings });
  };

  var config;
  try { config = Config.build(ss); } catch (e) { return fail('settings', 'Cannot read _developer_settings: ' + e.message); }
  if (config.router.workspaceKey) {
    return fail('already-linked', 'This workbook is already linked to ' + config.router.workspaceKey +
      '. Release it from the implementations app before linking it elsewhere.');
  }

  var clientName = '';
  try { clientName = Config._str(Customer.readOne(ss, config, 'clientName')); } catch (e) {}
  if (!clientName) return fail('customer', 'Client name is blank in 1_customer; fill it in before linking.');

  var analystEmail = '';
  try { analystEmail = Config._str(Customer.readOne(ss, config, 'analystEmail')); } catch (e) {}
  if (!analystEmail) {
    analystEmail = Config._str(Util.getActiveUserEmail(''));
    if (analystEmail) warnings.push('1_customer has no analyst email; the signed-in user (' + analystEmail + ') was invited instead.');
  }

  var settings;
  try { settings = Registry.settingsFromProperties(); } catch (e) { return fail('settings', e.message); }

  log('INFO', 'Linking: claiming a workspace for ' + clientName + '...');
  var claim;
  try {
    claim = Registry.claim(settings, {
      clientName: clientName, spreadsheetId: ss.getId(), workbookUrl: ss.getUrl(), correlationId: correlationId,
      analystEmail: analystEmail
    });
  } catch (e) { return fail('claim', 'The router did not claim a workspace: ' + e.message); }
  log('INFO', 'Claimed ' + claim.workspace_key + '.');

  var applied;
  try {
    applied = Registry.applyToWorkbook(ss, { 
      routerBaseUrl: settings.lifecycleBaseUrl, workspaceKey: claim.workspace_key,
      integrationAccountEmail: Config._secret('SDC_INTEGRATION_ACCOUNT_EMAIL')});
    if (Migrations.isMigrationNeeded(ss)) {
      var mig = Migrations.run(ss);
      if (!mig.ok) throw new Error('Workbook schema migration failed: ' + mig.message);
    }
  } catch (e) {
    log('ERROR', 'Settings write failed after claim; releasing ' + claim.workspace_key + ': ' + e.message);
    try { Registry.release(settings, claim.workspace_key, correlationId); }
    catch (e2) {
      return fail('apply-release-failed', 'Claim could not be written to the workbook (' + e.message + ') and releasing ' +
        claim.workspace_key + ' also failed (' + e2.message + '). Ask ops to check that workspace in the registry.');
    }
    return fail('apply', 'Claim rolled back: ' + e.message);
  }

  var inv = claim.invite && typeof claim.invite === 'object'
    ? { attempted: claim.invite.attempted === true || claim.invite.attempted === 'true',
        status: String(claim.invite.status || 'skipped'), message: String(claim.invite.message || '') }
    : { attempted: false, status: 'skipped', message: 'The router did not report an invitation.' };
  if (inv.status === 'failed') warnings.push('Workspace invitation failed: ' + inv.message);

  log('SUCCESS', 'Linked to ' + claim.workspace_key + '; wrote ' + applied.written.join(', ') + '. Invitation: ' + inv.status + '.');
  return Result.ok({
    flow: 'link', correlationId: correlationId,
    message: 'Linked to workspace ' + claim.workspace_key + '.',
    data: { workspaceKey: claim.workspace_key, state: claim.state || 'bound', analystEmail: analystEmail, invite: inv, written: applied.written },
    warnings: warnings
  });
};

// --- Private helpers -------------------------------------------------

Registry._key = function(workspaceKey) {
  var k = String(workspaceKey || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,63}$/.test(k)) {
    throw new Error('Registry: "' + k + '" is not a valid workspace key (letters, digits and hyphens).');
  }
  return k;
};

Registry._call = function(settings, method, path, body, opts) {
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
  // Same option Webhook.call passes for provision; only the long calls (release) set it.
  if (opts && opts.fetchTimeoutSeconds) options.fetchTimeoutSeconds = opts.fetchTimeoutSeconds;

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
