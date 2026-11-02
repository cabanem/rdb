/**
 * WebApp — HtmlService entry point and the three server calls the page makes.
 * Deploy as a web app: Execute as "User accessing the web app", access "Anyone within <org>".
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('SDC – new implementation')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Schema for the form, plus enough context to show what the app is wired to. */
function getFormSchema() {
  var schema = CustomerFields.formSchema();
  schema.context = {
    user: Session.getActiveUser().getEmail(),
    registryMode: Registry.mode(),
    libraryAttached: typeof SDC !== 'undefined',
    templateConfigured: !!PropertiesService.getScriptProperties().getProperty('SDC_BASE_TEMPLATE_ID')
  };
  return schema;
}

/**
 * Field packs available to pre-shape 4_fields. Reads the packs folder directly
 * (one Google Sheet per pack, carrying a `_pack` tab). Listing is real; applying
 * a pack is intentionally NOT part of this demo — see createImplementation.
 */
function getPacks() {
  var folderId = PropertiesService.getScriptProperties().getProperty('SDC_PACKS_FOLDER_ID');
  if (!folderId) return [];
  var out = [], files = DriveApp.getFolderById(folderId).getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) { var f = files.next(); out.push({ id: f.getId(), name: f.getName() }); }
  return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/**
 * Create implementation = copy BASE, fill 1_customer, record it.
 * Provisioning is a separate action by design and is not invoked here.
 */
function createImplementation(form) {
  var wb = Workbook.create({ customer: form.customer });

  var pack = { applied: false, note: 'Pack application is out of scope for this demo. Run "Set up from field pack" from the workbook menu.' };
  if (form.packId) pack.selected = form.packId;

  var reg = Registry.recordCreated({ spreadsheetId: wb.spreadsheetId, url: wb.url, clientName: form.customer.clientName });

  return { workbook: wb, pack: pack, registry: reg };
}

function listImplementations() { return Registry.list(); }
