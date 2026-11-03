/**
 * Workbook — create a config workbook from the template and fill 1_customer, then let the library judge it.
 *
 * Lives in app_sdc-router, so it reuses that project's helpers rather than re-reading `_settings`:
 *   readSettings_(ss)                 template.workbookId / destinationFolderId, workbook.* defaults, router.*
 *   generateWorkbook_(settings, name) the same Drive copy "Claim workspace…" makes
 * and the library for everything after the copy:
 *   Migrations.isMigrationNeeded / run, Customer.read, Preflight.run({requireCustomerData:true}), Log.append.
 *
 * One deliberate difference from claimWorkspace(): the workbook.* defaults (integration account, export folder,
 * editors) are written here, before Preflight, instead of at claim time. Preflight requires
 * sharing.integrationAccountEmail, and the point of this step is to know whether provision would start.
 * Registry.applyToWorkbook writes the same keys again on claim; the upsert is idempotent.
 */
var Workbook = (function () {

  /**
   * @param {Object} args  { customer: {<registry key>: value}, name?: string, correlationId?: string }
   * @return {Object} { spreadsheetId, url, correlationId, stages, written, missingRanges, readback, preflight }
   */
  function create(args) {
    var host = SpreadsheetApp.getActiveSpreadsheet();
    var settings = readSettings_(host);
    var missing = CustomerFields.missingRequired(args.customer);
    if (missing.length) throw new Error('Required fields missing: ' + missing.join(', '));

    var cid = args.correlationId || SDC.Util.newCorrelationId();
    var hostLog = SDC.Log.forCorrelation(host, cid);
    var stages = [];
    var stage = function (name, fn) {
      try { var d = fn(); stages.push({ name: name, ok: true, detail: d }); return d; }
      catch (e) { stages.push({ name: name, ok: false, detail: String(e.message || e) }); throw e; }
    };

    // 1. Copy — tabs, named ranges, _developer_settings, _script_logs and the bound shim travel with the file.
    var clientName = String(args.customer.clientName).trim();
    var ss = stage('copy', function () { return generateWorkbook_(settings, args.name || (clientName + ' - SDC configuration')); });
    hostLog('INFO', 'Generated config workbook "' + ss.getName() + '" (' + ss.getId() + ') from the web app.');
    var log = function (status, msg) { try { SDC.Log.append(ss, status, msg, cid); } catch (ignore) {} };
    log('INFO', 'Workbook created from the template by the implementations web app.');

    // 2. Workbook defaults from _settings, so the provision gate can be evaluated before any claim.
    stage('defaults', function () {
      var w = settings.workbook, written = [];
      if (w.integrationAccountEmail) { upsertDev_(ss, 'sharing', 'integrationAccountEmail', w.integrationAccountEmail, ''); written.push('sharing.integrationAccountEmail'); }
      if (w.configExportFolderId)    { upsertDev_(ss, 'storage', 'configExportFolderId',    w.configExportFolderId,    ''); written.push('storage.configExportFolderId'); }
      if (w.authorizedEditors)       { upsertDev_(ss, 'sharing', 'authorizedEditors',       w.authorizedEditors,       ''); written.push('sharing.authorizedEditors'); }
      return written.length ? written.join(', ') : 'nothing to write (_settings workbook.* blank)';
    });

    // 3. Migrate if the template lags the library (claimWorkspace does the same after binding).
    stage('migrate', function () {
      if (!SDC.Migrations.isMigrationNeeded(ss)) return 'already at schema ' + SDC.Version.SCHEMA;
      var r = SDC.Migrations.run(ss);
      if (!r.ok) throw new Error(r.message);
      return r.message;
    });

    // 4. 1_customer through the named ranges — the cells an analyst would type into.
    var written = stage('write-customer', function () { return writeCustomer_(ss, args.customer); });
    SpreadsheetApp.flush();

    // 5. Provenance.
    stage('stamp', function () {
      upsertDev_(ss, 'webapp', 'createdBy',     Session.getActiveUser().getEmail(), 'Analyst who created this workbook from the implementations app');
      upsertDev_(ss, 'webapp', 'createdAt',     new Date().toISOString(),           'Creation time, UTC');
      upsertDev_(ss, 'webapp', 'correlationId', cid,                                'Correlation id of the creating run');
      return 'webapp.createdBy / createdAt / correlationId';
    });

    // 6. Read back through the library, then the provision gate. Reported, not thrown: the workbook exists either way.
    var config = SDC.Config.build(ss);
    var readback = SDC.Customer.read(ss, config);
    var preflight;
    try {
      var pf = SDC.Preflight.run(ss, config, { requireCustomerData: true });
      preflight = { ok: true, message: 'Ready to provision (Preflight passed).', integrationAccountEmail: pf.integrationAccountEmail };
      log('SUCCESS', 'Preflight passed from the implementations app.');
    } catch (e) {
      preflight = { ok: false, message: String(e.message || e) };
      log('WARNING', 'Preflight did not pass after creation: ' + preflight.message);
    }
    stages.push({ name: 'preflight', ok: preflight.ok, detail: preflight.message });

    return {
      spreadsheetId: ss.getId(), url: ss.getUrl(), name: ss.getName(), correlationId: cid, stages: stages,
      written: written.written, missingRanges: written.missing,
      readback: { values: readback.values, healed: readback.healed, unresolved: readback.unresolved },
      preflight: preflight
    };
  }

  function writeCustomer_(ss, customer) {
    var written = [], missing = [], tz = ss.getSpreadsheetTimeZone();
    CustomerFields.registry().forEach(function (d) {
      var raw = customer[d.key];
      var blank = raw === undefined || raw === null || raw === '' || (typeof raw === 'string' && raw.trim() === '');
      if (d.type !== 'bool' && blank) return;
      var range;
      try { range = ss.getRangeByName(d.rangeName); } catch (e) { range = null; }
      if (!range) { missing.push(d.rangeName); return; }
      var v = coerce_(d.type, raw);
      range.setValue(v);
      written.push({ key: d.key, a1: range.getSheet().getName() + '!' + range.getA1Notation(),
                     value: Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v });
    });
    return { written: written, missing: missing };
  }

  /** Form value → the cell value an analyst would have produced. Parsing stays in the library. */
  function coerce_(type, raw) {
    switch (type) {
      case 'int':     return parseInt(String(raw).trim(), 10);
      case 'intList': return String(raw).split(/[,;\s]+/).filter(Boolean).join(', ');       // Customer.parseIntList
      case 'date':    var p = String(raw).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));  // Util.toIsoDate
      case 'bool':    return raw === true || /^(true|yes|on|1)$/i.test(String(raw));          // Util.coerceTruthy
      default:        return String(raw);
    }
  }

  /** _developer_settings row convention: A unused, B category, C key, D value, E description. */
  function upsertDev_(ss, category, key, value, description) {
    var sh = ss.getSheetByName('_developer_settings');
    if (!sh) throw new Error('_developer_settings is missing; not an SDC config workbook.');
    var rows = sh.getDataRange().getValues();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] === category && rows[i][2] === key) { sh.getRange(i + 1, 4).setValue(value); return; }
    }
    sh.appendRow(['', category, key, value, description || '']);
  }

  return { create: create };
})();
