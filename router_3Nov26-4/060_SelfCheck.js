/**
 * selfCheck — run from the Apps Script editor (select selfCheck, press Run) to find what is missing before
 * touching the page. Prints a report to the execution log and writes one line to _script_logs.
 * Read-only apart from Log.ensureSchema (creates the hidden _script_logs tab if absent, as onOpen does).
 */
function selfCheck() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  var ok = function (name, detail) { out.push('ok        ' + name + (detail ? ' — ' + detail : '')); };
  var bad = function (name, detail) { out.push('MISSING   ' + name + (detail ? ' — ' + detail : '')); };

  // 1. Files in this project
  var modules = { CustomerFields: typeof CustomerFields !== 'undefined', Workbook: typeof Workbook !== 'undefined',
                  Registry: typeof Registry !== 'undefined', Health: typeof Health !== 'undefined' };
  var files = { CustomerFields: '010_CustomerFields.js', Workbook: '020_Workbook.js', Registry: '030_Registry.js', Health: '050_Health.js' };
  Object.keys(modules).forEach(function (m) { modules[m] ? ok('module ' + m) : bad('module ' + m, 'add ' + files[m]); });
  var helpers = { readSettings_: typeof readSettings_, generateWorkbook_: typeof generateWorkbook_,
                  refreshRegistry_: typeof refreshRegistry_, extractSpreadsheetId_: typeof extractSpreadsheetId_ };
  Object.keys(helpers).forEach(function (f) { helpers[f] === 'function' ? ok('Code.js helper ' + f) : bad('Code.js helper ' + f); });

  // 2. Library
  try { ok('lib_sdc as SDC', SDC.Version.LIBRARY + ' / schema ' + SDC.Version.SCHEMA + ', ' + SDC.CUSTOMER_FIELDS.length + ' customer fields'); }
  catch (e) { bad('lib_sdc as SDC', e.message); }

  // 3. Script properties
  var p = PropertiesService.getScriptProperties();
  ok('REGISTRY_MODE', (p.getProperty('REGISTRY_MODE') || '(unset → dry_run)'));
  ok('ALLOW_PROVISION', (p.getProperty('ALLOW_PROVISION') || '(unset → provision button hidden)'));

  // 4. _settings
  var settings = null;
  try { settings = readSettings_(ss); ok('_settings router.*', 'lifecycle ' + settings.registry.lifecycleBaseUrl); }
  catch (e) { bad('_settings', e.message + ' (readSettings_ needs router.baseUrl, router.lifecycleBaseUrl and router.apiToken even in dry run)'); }
  if (settings) {
    if (settings.template.workbookId) {
      try { var t = SpreadsheetApp.openById(settings.template.workbookId); ok('template.workbookId', t.getName());
            var cfg = SDC.Config.build(t);
            cfg.storage.packsFolderId ? ok('template → storage.packsFolderId') : bad('template → storage.packsFolderId', 'pack list will be empty');
            SDC.Migrations.isMigrationNeeded(t) ? bad('template schema', 'behind ' + SDC.Version.SCHEMA + '; every copy will be migrated') : ok('template schema', SDC.Version.SCHEMA);
            var cust = SDC.Customer.read(t, cfg);
            cust.unresolved.length ? bad('template named ranges', 'unresolved: ' + cust.unresolved.map(function (u) { return u.rangeName; }).join(', ')) : ok('template named ranges', 'all ' + SDC.CUSTOMER_FIELDS.length + ' resolve');
      } catch (e) { bad('template.workbookId', e.message); }
    } else bad('template.workbookId', 'blank; Create workbook will fail');
    if (settings.template.destinationFolderId) {
      try { ok('template.destinationFolderId', DriveApp.getFolderById(settings.template.destinationFolderId).getName()); }
      catch (e) { bad('template.destinationFolderId', e.message); }
    } else bad('template.destinationFolderId', 'blank; copies land in the creator\'s My Drive root');
    settings.workbook.integrationAccountEmail ? ok('workbook.integrationAccountEmail') : bad('workbook.integrationAccountEmail', 'Preflight will fail on every new workbook unless the template carries sharing.integrationAccountEmail');
  }

  // 5. Logging
  var hadLog = !!ss.getSheetByName('_script_logs');
  SDC.Log.ensureSchema(ss);
  hadLog ? ok('_script_logs') : bad('_script_logs', 'was missing; created now (Log.append silently skips when it is absent)');

  // 6. Web app deployment reminder (cannot be read from script)
  out.push('note      a web app serves its DEPLOYED version: after adding or editing files, Deploy → Manage deployments → edit → new version; the /dev URL serves head');

  var report = out.join('\n');
  Logger.log(report);
  SDC.Log.append(ss, out.some(function (l) { return l.indexOf('MISSING') === 0; }) ? 'WARNING' : 'SUCCESS',
    'selfCheck: ' + out.filter(function (l) { return l.indexOf('MISSING') === 0; }).length + ' missing', SDC.Util.newCorrelationId());
  return report;
}
