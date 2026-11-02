/**
 * Workbook — create a config workbook from BASE and fill 1_customer, then let the library judge it.
 *
 * Every step after the Drive copy is something the shim already does from a menu, called here against a
 * spreadsheet ID instead of the active sheet:
 *   Migrations.isMigrationNeeded / run      ("Migrate workbook schema...")
 *   Customer.read                            (the named-range read Preflight and Payload.provision use)
 *   Preflight.run({requireCustomerData:true}) (the gate Provision.run passes through first)
 *   Log.append                               (same _script_logs tab, same correlation id)
 *
 * Script properties: SDC_BASE_TEMPLATE_ID, SDC_WORKBOOKS_FOLDER_ID (a shared-drive folder).
 */
var Workbook = (function () {

  function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

  function openBase() {
    var id = prop_('SDC_BASE_TEMPLATE_ID');
    if (!id) throw new Error('SDC_BASE_TEMPLATE_ID is not set in script properties.');
    return SpreadsheetApp.openById(id);
  }

  /**
   * @param {Object} args  { customer: {<registry key>: value}, name?: string, correlationId?: string }
   * @return {Object} { spreadsheetId, url, correlationId, stages: [{name, ok, detail}], readback, preflight }
   */
  function create(args) {
    var folderId = prop_('SDC_WORKBOOKS_FOLDER_ID');
    if (!folderId) throw new Error('SDC_WORKBOOKS_FOLDER_ID is not set in script properties.');

    var missing = CustomerFields.missingRequired(args.customer);
    if (missing.length) throw new Error('Required fields missing: ' + missing.join(', '));

    var cid = args.correlationId || SDC.Util.newCorrelationId();
    var stages = [];
    var stage = function (name, fn) {
      try { var d = fn(); stages.push({ name: name, ok: true, detail: d }); return d; }
      catch (e) { stages.push({ name: name, ok: false, detail: String(e.message || e) }); throw e; }
    };

    // 1. Copy. Named ranges, _developer_settings, _script_logs and the bound shim all travel with the file.
    var ss = stage('copy', function () {
      var title = args.name || ('SDC config – ' + String(args.customer.clientName).trim());
      var file = DriveApp.getFileById(prop_('SDC_BASE_TEMPLATE_ID')).makeCopy(title, DriveApp.getFolderById(folderId));
      return SpreadsheetApp.openById(file.getId());
    });
    var log = function (status, msg) { try { SDC.Log.append(ss, status, msg, cid); } catch (ignore) {} };
    log('INFO', 'Workbook created from BASE by the kickoff web app.');

    // 2. Bring the copy to the library's schema if BASE lags (the shim would offer this as a menu item).
    stage('migrate', function () {
      if (!SDC.Migrations.isMigrationNeeded(ss)) return 'already at schema ' + SDC.Version.SCHEMA;
      var r = SDC.Migrations.run(ss);
      if (!r.ok) throw new Error(r.message);
      return r.message;
    });

    // 3. Write 1_customer through the named ranges — the same cells an analyst would type into.
    var written = stage('write-customer', function () { return writeCustomer_(ss, args.customer); });
    SpreadsheetApp.flush();

    // 4. Provenance, in the place the library already keeps machine settings (col B category, C key, D value, E description).
    stage('stamp', function () {
      upsertDeveloperSetting_(ss, 'webapp', 'createdBy', Session.getActiveUser().getEmail(), 'Analyst who created this workbook from the kickoff app');
      upsertDeveloperSetting_(ss, 'webapp', 'createdAt', new Date().toISOString(), 'Creation time, UTC');
      upsertDeveloperSetting_(ss, 'webapp', 'correlationId', cid, 'Correlation id of the creating run');
      return 'webapp.createdBy / createdAt / correlationId';
    });

    // 5. Read back through the library's own reader, then run the provision gate. Neither throws out of create():
    //    a workbook that fails Preflight is still a real workbook the analyst can finish in the sheet.
    var config = SDC.Config.build(ss);
    var readback = SDC.Customer.read(ss, config);
    var preflight;
    try {
      var pf = SDC.Preflight.run(ss, config, { requireCustomerData: true });
      preflight = { ok: true, message: 'Ready to provision (Preflight passed).', integrationAccountEmail: pf.integrationAccountEmail };
      log('SUCCESS', 'Preflight passed from the kickoff app.');
    } catch (e) {
      preflight = { ok: false, message: String(e.message || e) };
      log('WARNING', 'Preflight did not pass after creation: ' + preflight.message);
    }
    stages.push({ name: 'preflight', ok: preflight.ok, detail: preflight.message });

    return {
      spreadsheetId: ss.getId(), url: ss.getUrl(), correlationId: cid, stages: stages,
      written: written.written, missingRanges: written.missing,
      readback: { values: readback.values, healed: readback.healed, unresolved: readback.unresolved },
      preflight: preflight
    };
  }

  function writeCustomer_(ss, customer) {
    var written = [], missing = [];
    CustomerFields.registry().forEach(function (d) {
      var raw = customer[d.key];
      var blank = raw === undefined || raw === null || raw === '' || (typeof raw === 'string' && raw.trim() === '');
      if (d.type !== 'bool' && blank) return;                       // leave the template cell alone
      var range;
      try { range = ss.getRangeByName(d.rangeName); } catch (e) { range = null; }
      if (!range) { missing.push(d.rangeName); return; }
      var v = coerce_(d.type, raw);
      range.setValue(v);
      written.push({ key: d.key, a1: range.getSheet().getName() + '!' + range.getA1Notation(), value: v instanceof Date ? Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : v });
    });
    return { written: written, missing: missing };
  }

  /** Form value → the cell value an analyst would have produced. Parsing and validation stay in the library. */
  function coerce_(type, raw) {
    switch (type) {
      case 'int':     return parseInt(String(raw).trim(), 10);
      case 'intList': return String(raw).split(/[,;\s]+/).filter(Boolean).join(', ');     // Customer.parseIntList reads this
      case 'date':    var p = String(raw).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));  // Util.toIsoDate
      case 'bool':    return raw === true || /^(true|yes|on|1)$/i.test(String(raw));        // Util.coerceTruthy
      default:        return String(raw);
    }
  }

  /** Same row convention Config.build reads and Registry.applyToWorkbook / Packs._stamp write. */
  function upsertDeveloperSetting_(ss, category, key, value, description) {
    var sh = ss.getSheetByName('_developer_settings');
    if (!sh) throw new Error('_developer_settings is missing.');
    var rows = sh.getDataRange().getValues();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] === category && rows[i][2] === key) { sh.getRange(i + 1, 4).setValue(value); return; }
    }
    sh.appendRow(['', category, key, value, description || '']);
  }

  return { create: create, openBase: openBase };
})();
