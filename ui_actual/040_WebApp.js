/**
 * WebApp — HtmlService entry point and the server calls the page makes.
 * Deploy: execute as "User accessing the web app", access "Anyone within <org>".
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('SDC – new implementation');
}

function getFormSchema() {
  var s = CustomerFields.formSchema();
  s.context = {
    user: Session.getActiveUser().getEmail(),
    registryMode: Registry.mode(),
    templateConfigured: !!PropertiesService.getScriptProperties().getProperty('SDC_BASE_TEMPLATE_ID'),
    provisionEnabled: PropertiesService.getScriptProperties().getProperty('ALLOW_PROVISION') === 'true'
  };
  return s;
}

/**
 * Packs, through the library. Packs.list needs a config for storage.packsFolderId; before a workbook exists the
 * BASE template's own _developer_settings is the right source — every copy inherits it.
 */
function getPacks() {
  try {
    var config = SDC.Config.build(Workbook.openBase());
    return SDC.Packs.list(config);           // [{fileId, name, pack_id, vms, record_type, pack_version, vms_spec_date}]
  } catch (e) { return []; }
}

/** Tenant questions for a pack (the shim asks these one alert at a time; the page shows them together). */
function getPackQuestions(fileId) {
  var pack = SDC.Packs.read(fileId), seen = {};
  return pack.questions.filter(function (q) { if (seen[q.question_id]) return false; seen[q.question_id] = true; return true; })
    .map(function (q) { return { id: q.question_id, prompt: q.prompt, field: q.field, effect: q.effect }; });
}

/**
 * Create implementation: copy BASE, fill 1_customer, optionally apply a pack, record it. No provisioning.
 * form = { customer: {...}, pack?: { fileId, answers: {qid: bool}, mode: 'standard'|'discovery' } }
 */
function createImplementation(form) {
  var cid = SDC.Util.newCorrelationId();
  var wb = Workbook.create({ customer: form.customer, correlationId: cid });
  var ss = SpreadsheetApp.openById(wb.spreadsheetId);

  var pack = { applied: false };
  if (form.pack && form.pack.fileId) {
    // Same call the shim's setupFromPack makes. replace:true matches the shim; the copy's 4_fields is BASE's anyway.
    var r = SDC.Packs.apply(ss, { fileId: form.pack.fileId, answers: form.pack.answers || {}, scope: null,
                                  mode: form.pack.mode || 'standard', replace: true });
    pack = { applied: r.ok, message: r.message, warnings: r.warnings || [],
             counts: r.data && r.data.counts, validation: r.data && r.data.validationResult };
  }

  var reg = Registry.recordCreated({ spreadsheetId: wb.spreadsheetId, url: wb.url, clientName: form.customer.clientName, correlationId: cid });
  return { workbook: wb, pack: pack, registry: reg };
}

/**
 * Provision from the app — the same library call as the shim's "Start supplier data collection". Off unless
 * script property ALLOW_PROVISION = true, because the routing path is still being verified.
 */
function provisionImplementation(spreadsheetId, isInitial) {
  if (PropertiesService.getScriptProperties().getProperty('ALLOW_PROVISION') !== 'true') {
    throw new Error('Provisioning from the app is disabled (ALLOW_PROVISION). Use the workbook menu.');
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);
  return SDC.Provision.run(ss, { isInitial: isInitial !== false });
}

function listImplementations() { return Registry.list(); }
