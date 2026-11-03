/**
 * WebApp — HtmlService entry point and the server calls the page makes. Lives in app_sdc-router next to Code.js.
 *
 * Every server call runs through trace_(): one correlation id, an INFO line when it starts, SUCCESS or ERROR when it
 * ends, in the routing workbook's _script_logs — the same sheet and shape Code.js's menu actions use. Errors are
 * rethrown with the correlation id appended, so the message the page shows can be found in the log.
 *
 * Configuration — nothing else is read:
 *   Script properties   REGISTRY_MODE      dry_run (default) | live
 *                       ALLOW_PROVISION    "true" to enable the Provision button
 *   _library_access tab A=email, B=ROLE (header row 1): a row with ROLE "developer" opens the Technical details view,
 *                       workspace status and release. Everyone else is an analyst: create, link, prepare, register, close.
 *   _settings tab       router.baseUrl, router.lifecycleBaseUrl, router.apiToken   (readSettings_ requires all three,
 *                                                                                   even in dry run)
 *                       template.workbookId, template.destinationFolderId
 *                       workbook.integrationAccountEmail / configExportFolderId / authorizedEditors
 * Run selfCheck() from the editor (060_SelfCheck.js) to verify all of it in one go.
 */
function doGet() {
  SDC.Log.ensureSchema(SpreadsheetApp.getActiveSpreadsheet());     // Code.js does this in onOpen; a web app has no onOpen
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('SDC implementations');
}

/** Run fn under a correlation id with start / end log lines. Rethrows with the id so the page can quote it. */
function trace_(flow, detail, fn) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cid = SDC.Util.newCorrelationId();
  var log = SDC.Log.forCorrelation(ss, cid);
  log('INFO', 'webapp ' + flow + (detail ? ' ' + detail : '') + ' — started');
  try {
    var out = fn(cid);
    log('SUCCESS', 'webapp ' + flow + ' — ok');
    return out;
  } catch (e) {
    log('ERROR', 'webapp ' + flow + ' — ' + e.message);
    throw new Error(e.message + ' [correlation ' + cid + ']');
  }
}

/** Who is calling: 'developer' when _library_access lists their email with ROLE developer, otherwise 'analyst'. */
function userRole_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LIBRARY_ACCESS_SHEET);
  if (!sh) return { role: 'analyst', error: "'" + LIBRARY_ACCESS_SHEET + "' tab is missing, so nobody is a developer." };
  var me = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  var developer = rows.some(function (r) {
    return String(r[0] || '').trim().toLowerCase() === me && String(r[1] || '').trim().toLowerCase() === 'developer';
  });
  return { role: developer ? 'developer' : 'analyst', error: null };
}
/** The page hides developer controls, but any global function is callable from the browser; this is the real gate. */
function requireDeveloper_(what) {
  if (userRole_().role !== 'developer') throw new Error(what + ' is restricted to developers (ROLE in _library_access).');
}

/** Everything the page shows on its technical-details view, plus the flags that gate buttons elsewhere. */
function getContext() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), p = PropertiesService.getScriptProperties();
  var settingsError = null, templateConfigured = false;
  try { templateConfigured = !!readSettings_(ss).template.workbookId; }
  catch (e) { settingsError = e.message; }
  var lib = (typeof SDC_LIBRARY_PROJECTS !== 'undefined' && SDC_LIBRARY_PROJECTS[0]) || { name: 'lib_sdc', id: '' };
  var access = userRole_();
  return {
    user: Session.getActiveUser().getEmail(),
    role: access.role, accessError: access.error,
    host: { name: ss.getName(), url: ss.getUrl() },
    library: { name: lib.name, id: lib.id, version: SDC.Version.LIBRARY, schema: SDC.Version.SCHEMA },
    libraryVersion: SDC.Version.LIBRARY, schemaVersion: SDC.Version.SCHEMA,
    registryMode: Registry.mode(),
    templateConfigured: templateConfigured, settingsError: settingsError,
    provisionEnabled: p.getProperty('ALLOW_PROVISION') === 'true',
    healthAvailable: typeof Health !== 'undefined'
  };
}

// --- Kickoff --------------------------------------------------------------------------------------------------------
function getFormSchema() {
  return trace_('form-schema', '', function () { var s = CustomerFields.formSchema(); s.context = getContext(); return s; });
}

/** Packs.list needs a config for storage.packsFolderId; the template's own _developer_settings is the pre-workbook source. */
function getPacks() {
  return trace_('packs', '', function () {
    var settings = readSettings_(SpreadsheetApp.getActiveSpreadsheet());
    return SDC.Packs.list(SDC.Config.build(SpreadsheetApp.openById(settings.template.workbookId)));
  });
}

function getPackQuestions(fileId) {
  return trace_('pack-questions', fileId, function () {
    var pack = SDC.Packs.read(fileId), seen = {};
    return pack.questions.filter(function (q) { if (seen[q.question_id]) return false; seen[q.question_id] = true; return true; })
      .map(function (q) { return { id: q.question_id, prompt: q.prompt, field: q.field, effect: q.effect }; });
  });
}

/**
 * form = { customer: {...}, pack?: { fileId, answers, mode } }
 * Create → pack → record in the ledger. Creating never claims a workspace: linking is a separate action on the
 * Implementations view (claimWorkbook), taken when the analyst is ready.
 */
function createImplementation(form) {
  return trace_('create', form && form.customer && form.customer.clientName, function (cid) {
    var wb = Workbook.create({ customer: form.customer, correlationId: cid });

    var pack = { applied: false };
    if (form.pack && form.pack.fileId) {
      var r = SDC.Packs.apply(SpreadsheetApp.openById(wb.spreadsheetId), {
        fileId: form.pack.fileId, answers: form.pack.answers || {}, scope: null, mode: form.pack.mode || 'standard', replace: true
      });
      pack = { applied: r.ok, message: r.message, warnings: r.warnings || [], counts: r.data && r.data.counts };
    }

    var reg = Registry.recordCreated({ spreadsheetId: wb.spreadsheetId, url: wb.url, clientName: form.customer.clientName,
                                       analystEmail: form.customer.analystEmail, correlationId: cid });
    reg.mode = Registry.mode();
    return { workbook: wb, pack: pack, registry: reg };
  });
}

/** Link a workspace to a workbook created earlier (or any SDC config workbook by URL/ID). Live mode only. */
function claimWorkbook(spreadsheetId) {
  return trace_('claim', spreadsheetId, function (cid) { return Registry.claim(extractSpreadsheetId_(spreadsheetId), cid); });
}

// --- Implementations and the workspace pool ---------------------------------------------------------------------------
/** { mode, implementations: [...], pool: [...] } — see Registry.implementations. */
function listImplementations() {
  return trace_('list', '', function () { return Registry.implementations(userRole_().role === 'developer'); });
}
function getWorkspaceStatus(key) {
  return trace_('status', key, function () { requireDeveloper_('Status'); return Registry.status(key); });
}
/** Analysts prepare and register workspaces and close their own implementations; release is developer-only. */
function workspaceAction(op, key) {
  return trace_(op, key, function () { if (op === 'release') requireDeveloper_(op); return Registry.action(op, key); });
}

// --- Implementation health ------------------------------------------------------------------------------------------
function checkImplementation(spreadsheetId) {
  return trace_('check', spreadsheetId, function () {
    if (typeof Health === 'undefined') throw new Error('050_Health.js is not in this project.');
    return Health.check(extractSpreadsheetId_(spreadsheetId));
  });
}

// --- Provision (gated) ----------------------------------------------------------------------------------------------
function provisionImplementation(spreadsheetId, isInitial) {
  return trace_('provision', spreadsheetId, function () {
    if (PropertiesService.getScriptProperties().getProperty('ALLOW_PROVISION') !== 'true') {
      throw new Error('Provisioning from the app is disabled (ALLOW_PROVISION). Use the workbook menu.');
    }
    return SDC.Provision.run(SpreadsheetApp.openById(extractSpreadsheetId_(spreadsheetId)), { isInitial: isInitial !== false });
  });
}
