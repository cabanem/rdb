/**
 * Workbook — create a config workbook from the BASE template and fill 1_customer.
 *
 * What makes this cheap: the BASE template is a Google Sheet, so one Drive copy
 * brings along the tabs, the workbook-scoped named ranges, the _developer_settings
 * tab AND the container-bound shim. Writing a value into a named range is
 * indistinguishable from an analyst typing it into the cell behind that range,
 * so lib_sdc's Config.build, the content fingerprint and every downstream
 * consumer see exactly what they would see from a hand-filled workbook.
 *
 * Script properties used (set in Project settings → Script properties):
 *   SDC_BASE_TEMPLATE_ID    file ID of the BASE config workbook (master_config v0.9.9 layout)
 *   SDC_WORKBOOKS_FOLDER_ID folder (on a shared drive) where new workbooks land
 */
var Workbook = (function () {

  // How a `bool` field is represented in the 1_customer value cell.
  // UNVERIFIED against the live template — check what the analysts type today
  // (Yes/No, TRUE/FALSE, a checkbox) and make this match before relying on it.
  var BOOL_WRITE = { yes: 'Yes', no: 'No' };

  function props_() { return PropertiesService.getScriptProperties(); }

  /**
   * @param {Object} args
   * @param {Object} args.customer  values keyed by CUSTOMER_FIELDS.key, as submitted by the form
   * @param {string} [args.name]    workbook title; defaults to "SDC config – <client>"
   * @return {{spreadsheetId, url, written: Array, missingRanges: Array, readback: Object|null}}
   */
  function create(args) {
    var templateId = props_().getProperty('SDC_BASE_TEMPLATE_ID');
    var folderId   = props_().getProperty('SDC_WORKBOOKS_FOLDER_ID');
    if (!templateId || !folderId) throw new Error('Set SDC_BASE_TEMPLATE_ID and SDC_WORKBOOKS_FOLDER_ID in script properties.');

    var problems = CustomerFields.validate(args.customer);
    if (problems.length) throw new Error('Cannot create workbook: ' + problems.join('; '));

    var title  = args.name || ('SDC config – ' + args.customer.clientName);
    var folder = DriveApp.getFolderById(folderId);
    var copy   = DriveApp.getFileById(templateId).makeCopy(title, folder);
    var ss     = SpreadsheetApp.openById(copy.getId());

    var result = writeCustomer_(ss, args.customer);
    SpreadsheetApp.flush();

    // Stamp provenance where the library already keeps machine settings. Keys are
    // namespaced `webapp.*` so nothing in lib_sdc's Settings reader will claim them.
    setDeveloperSetting_(ss, 'webapp', 'createdBy', Session.getActiveUser().getEmail(), 'Analyst who created this workbook from the kickoff app');
    setDeveloperSetting_(ss, 'webapp', 'createdAt', new Date().toISOString(),        'Creation time (UTC)');

    return {
      spreadsheetId: ss.getId(),
      url: ss.getUrl(),
      written: result.written,
      missingRanges: result.missing,
      readback: readBack_(ss)
    };
  }

  /** Write each submitted value into its named range. Returns what was written and which ranges were absent. */
  function writeCustomer_(ss, customer) {
    var written = [], missing = [];
    CustomerFields.registry().fields.forEach(function (d) {
      var raw = customer[d.key];
      if (raw === undefined || raw === null || String(raw).trim() === '') return;   // leave the template's cell as-is
      var range = ss.getRangeByName(d.rangeName);
      if (!range) { missing.push(d.rangeName); return; }
      var value = coerce_(d.type, raw);
      range.setValue(value);
      written.push({ key: d.key, rangeName: d.rangeName, a1: range.getSheet().getName() + '!' + range.getA1Notation(), value: value });
    });
    return { written: written, missing: missing };
  }

  /** Form string → the cell value an analyst would have produced. Parsing stays in the library. */
  function coerce_(type, raw) {
    switch (type) {
      case 'int':     return parseInt(String(raw).trim(), 10);
      case 'intList': return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean).join(', ');
      case 'date':    var p = String(raw).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      case 'bool':    return (raw === true || /^(true|yes|on|1)$/i.test(String(raw))) ? BOOL_WRITE.yes : BOOL_WRITE.no;
      default:        return String(raw);
    }
  }

  /**
   * Prove equivalence: read the new workbook back through the library's own
   * named-range reader. If `SDC.Customer.read` is present this is the real
   * check — the same code path Preflight and the provision payload use.
   * Signature assumed as Customer.read(ss, config); verify against 004_Customer.js.
   */
  function readBack_(ss) {
    if (typeof SDC === 'undefined' || !SDC.Customer || typeof SDC.Customer.read !== 'function') {
      return { via: 'none', note: 'lib_sdc not attached; add the library to get a readback through Customer.read' };
    }
    try {
      var config = (SDC.Config && typeof SDC.Config.build === 'function') ? SDC.Config.build(ss) : undefined;
      var r = SDC.Customer.read(ss, config);
      return { via: 'SDC.Customer.read', values: r && r.values ? r.values : r };
    } catch (e) {
      return { via: 'SDC.Customer.read', error: String(e) };
    }
  }

  /** _developer_settings convention: category / key / value / description. Updates in place or appends. */
  function setDeveloperSetting_(ss, category, key, value, description) {
    var sh = ss.getSheetByName('_developer_settings');
    if (!sh) return;
    var rows = sh.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === category && rows[i][1] === key) { sh.getRange(i + 1, 3).setValue(value); return; }
    }
    sh.appendRow([category, key, value, description || '']);
  }

  return { create: create };
})();
