/**
 * WebApp — HtmlService entry point and the server calls the page makes. Add to app_sdc-router next to Code.js;
 * its appsscript.json already carries the SDC library and the webapp block (USER_ACCESSING / DOMAIN).
 * Script properties: REGISTRY_MODE (dry_run | live; default dry_run), ALLOW_PROVISION (true to enable).
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('SDC – implementations');
}

function getContext() {
  var p = PropertiesService.getScriptProperties(), settingsError = null, templateConfigured = false;
  try { templateConfigured = !!readSettings_(SpreadsheetApp.getActiveSpreadsheet()).template.workbookId; }
  catch (e) { settingsError = e.message; }
  return {
    user: Session.getActiveUser().getEmail(),
    libraryVersion: SDC.Version.LIBRARY, schemaVersion: SDC.Version.SCHEMA,
    registryMode: Registry.mode(),
    templateConfigured: templateConfigured, settingsError: settingsError,
    provisionEnabled: p.getProperty('ALLOW_PROVISION') === 'true'
  };
}

// --- Kickoff --------------------------------------------------------------------------------------------------------
function getFormSchema() { var s = CustomerFields.formSchema(); s.context = getContext(); return s; }

/** Packs.list needs a config for storage.packsFolderId; the template's own _developer_settings is the pre-workbook source. */
function getPacks() {
  try {
    var settings = readSettings_(SpreadsheetApp.getActiveSpreadsheet());
    return SDC.Packs.list(SDC.Config.build(SpreadsheetApp.openById(settings.template.workbookId)));
  } catch (e) { return []; }
}

function getPackQuestions(fileId) {
  var pack = SDC.Packs.read(fileId), seen = {};
  return pack.questions.filter(function (q) { if (seen[q.question_id]) return false; seen[q.question_id] = true; return true; })
    .map(function (q) { return { id: q.question_id, prompt: q.prompt, field: q.field, effect: q.effect }; });
}

/**
 * form = { customer: {...}, pack?: { fileId, answers, mode }, claim?: boolean }
 * Create → pack → record in the ledger → (only when form.claim) claim a workspace. A failed claim keeps the
 * workbook, as "Claim workspace…" keeps a generated one, and the page shows why; the workbook can be claimed later.
 */
function createImplementation(form) {
  var cid = SDC.Util.newCorrelationId();
  var wb = Workbook.create({ customer: form.customer, correlationId: cid });

  var pack = { applied: false };
  if (form.pack && form.pack.fileId) {
    var r = SDC.Packs.apply(SpreadsheetApp.openById(wb.spreadsheetId), {
      fileId: form.pack.fileId, answers: form.pack.answers || {}, scope: null, mode: form.pack.mode || 'standard', replace: true
    });
    pack = { applied: r.ok, message: r.message, warnings: r.warnings || [], counts: r.data && r.data.counts };
  }

  var reg = Registry.recordCreated({ spreadsheetId: wb.spreadsheetId, url: wb.url, clientName: form.customer.clientName, correlationId: cid });
  reg.mode = Registry.mode();
  if (form.claim) {
    try { Object.assign(reg, Registry.claim(wb.spreadsheetId, cid)); }
    catch (e) { reg.error = e.message; }
  }
  return { workbook: wb, pack: pack, registry: reg };
}

/** Claim a workspace for a workbook created earlier (or any SDC config workbook by URL/ID). Live mode only. */
function claimWorkbook(spreadsheetId) { return Registry.claim(extractSpreadsheetId_(spreadsheetId)); }

// --- Workspaces -----------------------------------------------------------------------------------------------------
function listWorkspaces()        { return { mode: Registry.mode(), rows: Registry.list(), unclaimed: Registry.listUnclaimed() }; }
function getWorkspaceStatus(key) { return Registry.status(key); }
function workspaceAction(op, key){ return Registry.action(op, key); }

// --- Implementation health ------------------------------------------------------------------------------------------
function checkImplementation(spreadsheetId) { return Health.check(extractSpreadsheetId_(spreadsheetId)); }

// --- Provision (gated) ----------------------------------------------------------------------------------------------
function provisionImplementation(spreadsheetId, isInitial) {
  if (PropertiesService.getScriptProperties().getProperty('ALLOW_PROVISION') !== 'true') {
    throw new Error('Provisioning from the app is disabled (ALLOW_PROVISION). Use the workbook menu.');
  }
  return SDC.Provision.run(SpreadsheetApp.openById(extractSpreadsheetId_(spreadsheetId)), { isInitial: isInitial !== false });
}
