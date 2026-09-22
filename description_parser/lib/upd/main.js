/**
 * @file main.gs (container-bound)
 *
 * Thin trigger and UI layer for the SDC platform. All real work lives
 * in the SDC library; this file only does what container scripts must:
 *
 *   - Define onOpen (must be a simple trigger in the container).
 *   - Resolve menu-callable function names in the container's global scope.
 *   - Translate library Result objects into spreadsheet UI.
 *
 * Library identifier: SDC. If adding the library to a new workbook,
 * set the identifier to SDC in Project Settings â†’ Libraries. The shim
 * names below assume that identifier and will not work otherwise.
 *
 * @author Emily Cabaniss
 * @since  2026-04-27 (v1.0 - full library lift)
 */


// --- Menu ------------------------------------------------------------

/**
 * Builds the custom menu on spreadsheet open. Also runs the Log schema self-heal 
 * so legacy workbooks gain the correlation_id column silently on first open after the v1.0 library install.
 */
function onOpen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  // 1. Create the first dropdown (submenu)
  var SM_cascade = ui.createMenu('Cascade helpers')
    .addItem('Stamp dropdowns', 'stampCascadeDropdowns')
    .addItem('Show completeness', 'showTrack2Sidebar')
    .addItem('Untype parent column', 'untypeParentValueColumn');

  var SM_additional = ui.createMenu('Additional features')
    .addItem('Validate configuration',         'validateConfiguration')
    .addItem('Preview template',               'previewTemplate')
    .addItem('Request portal access (analyst)','requestPortalAccess')
    .addItem('Update configuration',           'updateWorkspace')
    .addItem('Set up field IDs',               'setupPrimaryKeyColumns');

  // 2. Create the second dropdown (submenu)
  var SM_implementation = ui.createMenu('Implementation tools')
    .addItem('Set up from field pack...',      'setupFromPack')
    .addSeparator()
    .addItem('Validate configuration',         'validateConfiguration')
    .addItem('Preview template',               'previewTemplate')
    .addSeparator()
    .addItem('Start supplier data collection', 'initializeWorkspace')
    .addItem('Send supplier invitations',      'sendAllInvitations')
    .addSeparator()
    .addItem('Update configuration',           'updateWorkspace')
    .addSeparator()
    .addSubMenu(SM_additional);

  // Description parser lives in its own library (identifier DP). Guarded so a workbook whose shim
  // has not added that library still gets the SDC menu instead of a failed onOpen.
  if (typeof DP !== 'undefined') SM_implementation.addSubMenu(DP.dpMenu(ui));


  // 3. Add the conditional items to the SM_implementation submenu
  if (SDC.Migrations.isMigrationNeeded(ss)) {
    SM_implementation.addSeparator();
    SM_implementation.addItem('Migrate workbook schema...', 'migrateWorkbookSchema');
  }

  // 4. Create the main parent menu and attach the dropdowns
  ui.createMenu('Supplier Data Collection')
    .addSubMenu(SM_implementation) // This creates the first dropdown
    .addSeparator()
    .addSubMenu(SM_cascade)        // This creates the second dropdown
    .addToUi();
}

function sendAllInvitations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  var ui = SpreadsheetApp.getUi();
  var INVITE_WEBHOOK_URL = 'https://webhooks.eu.workato.com/webhooks/rest/c8447e21-1b2d-4d89-b096-049e955ea553/issue-invitations';

  var confirm = ui.alert(
    'Send invitations',
    'Send invitations to all pending suppliers?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  ss.toast('Sending invitations request...', 'Status');
  UrlFetchApp.fetch(INVITE_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ analyst_email: Session.getActiveUser().getEmail(), ssId: ssId }),
    muteHttpExceptions: true
  });
  ss.toast('');

  ui.alert(
    'Sent',
    'Invitations have been requested. Workato is processing them in the background.',
    ui.ButtonSet.OK
  );
}

// --- Flow shims ------------------------------------------------------
/**
 * Provision flow - initial run. Triggered by "Start supplier data collection" menu item. Carries is_initial=true into the webhook
 * payload so the downstream recipe can distinguish first-time setup from subsequent updates.
 */
function initializeWorkspace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Sending to Workato...', 'Status');
  var r = SDC.Provision.run(ss, { isInitial: true });
  ss.toast('');
  showResult_(r);
}

/**
 * Provision flow - update run. Triggered by "Update configuration" menu item. Carries is_initial=false. Same pipeline as initial;
 * differs only in the payload flag.
 */
function updateWorkspace() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Sending to Workato...', 'Status');
  var r = SDC.Provision.run(ss, { isInitial: false });
  ss.toast('');
  showResult_(r);
}

/**
 * Validate flow. Renders structured validation results in a modal when the success Result carries them; falls back to standard alert otherwise.
 */
function validateConfiguration() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Validating configuration...', 'Status');
  var r = SDC.Validate.run(ss);
  ss.toast('');

  if (r.ok && r.data && r.data.validationResult) {
    showValidationResults_(r.data.validationResult);
  } else {
    showResult_(r);
  }
}

/**
 * Portal-invite flow.
 */
function requestPortalAccess() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Requesting portal access...', 'Status');
  var r = SDC.Portal.run(ss);
  ss.toast('');
  showResult_(r);
}

/**
 * Invitations flow. Reads selected rows from _suppliers, posts the supplier_request_ids to R1, renders the response summary in a modal.
 */
function sendInvitations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var supplierRequestIds = readSelectedSupplierRequestIds_();
  if (supplierRequestIds.length === 0) {
    SpreadsheetApp.getUi().alert(
      'No suppliers selected',
      'Switch to the _suppliers tab and select one or more rows ' +
      'before clicking Send invitations.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }

  ss.toast('Sending ' + supplierRequestIds.length + ' invitation(s)...', 'Status');
  var r = SDC.Invitations.run(ss, { supplierRequestIds: supplierRequestIds });
  ss.toast('');

  // Rich modal when structured data is present; fall back to standard alert.
  if (r.ok && r.data && r.data.results) {
    showInvitationResults_(r);
  } else {
    showResult_(r);
  }
}


// --- Setup / maintenance shims --------------------------------------
/**
 * One-time PK column setup. Idempotent - safe to re-run on existing workbooks; no-op for sheets already correctly configured.
 *
 * Now returns a canonical Result; routed through the shared translator.
 */
function setupPrimaryKeyColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var r  = SDC.PrimaryKey.setupColumns(ss);
  showResult_(r);
}

/**
 * Migrate the workbook to the library's expected schema version. Confirmed before running because it mutates _developer_settings
 * and may change sheet structure in future versions.
 */
function migrateWorkbookSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var current = SDC.Migrations.currentWorkbookVersion(ss);
  var target  = SDC.Version.SCHEMA;

  var confirm = ui.alert(
    'Migrate workbook schema',
    'This will update the workbook from schema v' + current +
      ' to v' + target + '.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var r = SDC.Migrations.run(ss);
  showResult_(r);
}


// --- UI translation --------------------------------------------------
/**
 * Translate any canonical Result into a single ui.alert.
 *
 * Title:
 *   - Success, no warnings: "<Flow> - success"
 *   - Success, warnings:    "<Flow> - success with warnings"
 *   - Failure:              "<Flow> - failed"
 *
 * Body composition (in order):
 *   1. Result.message (always)
 *   2. Warnings block (when warnings.length > 0)
 *   3. Correlation ID line (only for Workato-talking flows: provision,
 *      validate, portalInvite - other flows generate IDs for log
 *      correlation but the user has nothing to do with them)
 *
 * Defensive: handles undefined/missing Result by surfacing a clear "no result returned" alert rather than a TypeError. This shouldn't
 * happen with the current library but protects against future shim mistakes.
 */
function showResult_(r) {
  var ui = SpreadsheetApp.getUi();

  if (!r) {
    ui.alert('Operation', 'No result returned from the library. This is a bug.', ui.ButtonSet.OK);
    return;
  }

  var flowLabel    = flowTitle_(r.flow);
  var hasWarnings  = Array.isArray(r.warnings) && r.warnings.length > 0;
  var titleSuffix  = r.ok
    ? (hasWarnings ? ' - success with warnings' : ' - success')
    : ' - failed';
  var title        = flowLabel + titleSuffix;

  var bodyParts = [String(r.message || '(no message)')];

  var details = resultDetails_(r);
  if (details.length > 0) {
    bodyParts.push('');
    details.forEach(function(line) { bodyParts.push(line); });
  }

  if (hasWarnings) {
    bodyParts.push('');
    bodyParts.push('Warnings:');
    r.warnings.forEach(function(w) {
      bodyParts.push(' - ' + w);
    });
  }

  if (showsCorrelationId_(r.flow) && r.correlationId) {
    bodyParts.push('');
    bodyParts.push('Correlation ID: ' + r.correlationId);
  }

  ui.alert(title, bodyParts.join('\n'), ui.ButtonSet.OK);
}
function showValidationResults_(validationResult) {
  var vr       = validationResult || {};
  var checks   = Array.isArray(vr.checks) ? vr.checks : [];

  var html = HtmlService.createHtmlOutput(validationResultsHtml_(checks))
    .setWidth(720)
    .setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Validation results');
}

/** Escape text before putting it in HTML (replaces the template's <?= ?> escaping). */
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validationResultsHtml_(checks) {
  var fails = [], warns = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i] || {};
    var st = c.c_status || c.status;   // mirror ValidationReport.toModel
    if (st === 'fail')      fails.push(c);
    else if (st === 'warn') warns.push(c);
  }

  var parts = [
    '<style>' +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;color:#202124;padding:16px 20px;margin:0;line-height:1.5;}" +
    'h3{margin:16px 0 8px;font-size:14px;font-weight:600;color:#3c4043;}' +
    'h3:first-child{margin-top:0;}' +
    '.count-badge{display:inline-block;padding:2px 8px;background:rgba(0,0,0,0.08);border-radius:10px;font-size:11px;margin-left:6px;}' +
    '.check{padding:8px 0;border-bottom:1px solid #f1f3f4;}' +
    '.check:last-child{border-bottom:none;}' +
    '.check-msg{font-weight:500;}' +
    '.check-name{color:#5f6368;font-size:11px;text-transform:uppercase;letter-spacing:.3px;margin-top:2px;}' +
    '.detail-list{margin:6px 0 0;padding-left:18px;} .detail-list li{margin:2px 0;}' +
    '.ok{color:#137333;}' +
    '</style>'
  ];

  if (fails.length === 0 && warns.length === 0) {
    parts.push('<p class="ok">\u2713 Validation passed. No errors or warnings.</p>');
    return parts.join('\n');
  }

  if (fails.length > 0) {
    parts.push('<h3>Errors <span class="count-badge">' + fails.length + '</span></h3>');
    parts.push(renderChecks_(fails));
  }
  if (warns.length > 0) {
    parts.push('<h3>Warnings <span class="count-badge">' + warns.length + '</span></h3>');
    parts.push(renderChecks_(warns));
  }
  return parts.join('\n');
}

/**
 * Render invitations summary + per-supplier results in a modal dialog. Template lives in the container 
 * so workbooks can rebrand without library changes.
 */
function renderChecks_(checks) {
  var out = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i] || {};
    out.push('<div class="check">');
    out.push('<div class="check-msg">' + esc_(c.message || c.check_name || '(no message)') + '</div>');
    if (c.check_name && c.message) {
      out.push('<div class="check-name">' + esc_(c.check_name) + '</div>');
    }
    var details = Array.isArray(c.details) ? c.details : [];
    if (details.length > 0) {
      out.push('<ul class="detail-list">');
      for (var j = 0; j < details.length; j++) {
        var d = details[j] || {};
        var label = [d.entity, d.name].filter(function(x){ return x != null && x !== ''; }).join(' ');
        var issue = esc_(d.issue || '');
        out.push('<li>' + (label ? esc_(label) + ' - ' + issue : issue) + '</li>');
      }
      out.push('</ul>');
    }
    out.push('</div>');
  }
  return out.join('\n');
}

function resultDetails_(r) {
  if (!r || !r.ok || !r.data) return [];
  var d = r.data;
  var lines = [];

  if (r.flow === 'provision') {
    if (d.applicationName) lines.push('Application: ' + d.applicationName);

    if (d.variantsGenerated > 0) {
      var names = Array.isArray(d.variantNames) && d.variantNames.length
        ? ' (' + d.variantNames.join(', ') + ')'
        : '';
      lines.push('Variant templates built: ' + d.variantsGenerated + names);
    } else {
      lines.push('Variant templates built: none (base template only)');
    }

    if (d.stampedRows > 0)        lines.push('New field IDs stamped: ' + d.stampedRows);
    if (d.auditShareGranted > 0)  lines.push('Audit access granted: ' + d.auditShareGranted + ' editor(s)');
  }
  return lines;
}

/**
 * Map canonical flow names to user-facing titles. Falls back to a generic "Operation" 
 * if the library introduces a flow name this shim doesn't know about - the alert still renders, just without
 * a flow-specific title.
 */
function flowTitle_(flow) {
  switch (flow) {
    case 'provision':       return 'Provision';
    case 'validate':        return 'Validation';
    case 'portalInvite':    return 'Portal invite';
    case 'invitations':     return 'Invitations';
    case 'primaryKeySetup': return 'Field ID setup';
    case 'migration':       return 'Schema migration';
    case 'preview':         return 'Template preview';
    default:                return 'Operation';
  }
}

/**
 * Read supplier_request_id values from the analyst's current selection
 * on the _suppliers tab. Defends against:
 *   - wrong sheet active
 *   - empty selection
 *   - header row in selection
 *   - non-UUID values in the action column
 *   - duplicate rows in the selection
 *
 * @returns {Array<string>} UUID strings; may be empty.
 */
function readSelectedSupplierRequestIds_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== '_suppliers') {
    return [];   // caller surfaces the "no rows" message
  }

  var range = sheet.getActiveRange();
  if (!range) return [];

  var startRow = range.getRow();
  var numRows  = range.getNumRows();

  // Action ID column. Matches the hidden column G we render in DASH-01.
  // If the column layout in _suppliers changes, this constant moves with it.
  var ACTION_ID_COL = 7;

  var values = sheet.getRange(startRow, ACTION_ID_COL, numRows, 1).getValues();

  var uuidRe = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
  var seen = {};
  var out  = [];

  values.forEach(function(row) {
    var v = String(row[0] || '').trim();
    if (uuidRe.test(v) && !seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  });

  return out;
}

/**
 * True for flows whose correlation ID has cross-system meaning (matches
 * a Workato request). Setup and migration generate correlation IDs for
 * log-line tying but the user has nothing to look up with them.
 */
function showsCorrelationId_(flow) {
  return flow === 'provision' || flow === 'validate' ||
         flow === 'portalInvite' || flow === 'invitations' ||
         flow === 'preview';
}

/**
 * Diagnostic: dump everything the 1_customer lookup path sees.
 * Run from the script editor; read the output in View -> Logs.
 */
function debugCustomerSheet() {
  var ss    = SpreadsheetApp.getActive();
  var U     = (typeof Util   !== 'undefined') ? Util   : SDC.Util;
  var L     = (typeof Labels !== 'undefined') ? Labels : SDC.Labels;
  var sheet = ss.getSheetByName('1_customer');
  if (!sheet) { Logger.log('FATAL: 1_customer not found'); return; }

  var data = sheet.getDataRange().getValues();
  var tz   = ss.getSpreadsheetTimeZone();

  function typeOf(v) {
    if (v instanceof Date) return 'Date';
    if (v === null || v === undefined) return 'null/undefined';
    if (v === '') return 'empty-string';
    return typeof v + (typeof v === 'number' ? ' (possible serial!)' : '');
  }
  function show(v) {
    if (v instanceof Date) return 'Date<' + Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm:ss") + '>';
    return JSON.stringify(v);
  }
  // Char-by-char dump: exposes NBSP (160), smart quotes (8216-8221), etc.
  function charCodes(s) {
    return String(s).split('').map(function(c) {
      var code = c.charCodeAt(0);
      return (code < 32 || code > 126) ? '[U+' + code.toString(16).toUpperCase() + ']' : c;
    }).join('');
  }

  // ---- 1. Every Labels entry: lookup result, locus, value type ----------
  Logger.log('==== 1. LABEL LOOKUPS ====');
  Object.keys(L).sort().forEach(function(key) {
    var label  = L[key];
    var target = String(label).toLowerCase().trim();
    var hits   = [];   // every matching cell, not just the first

    for (var i = 0; i < data.length; i++) {
      for (var j = 0; j < data[i].length; j++) {
        if (String(data[i][j]).toLowerCase().trim() === target) {
          hits.push({ row: i + 1, col: j + 1 });
        }
      }
    }

    if (hits.length === 0) {
      Logger.log('MISS   Labels.' + key + '  ("' + label + '") - not found in sheet');
      return;
    }

    var h   = hits[0];  // findValueRightOfLabel takes the first
    var row = data[h.row - 1];
    var vals = [];
    for (var k = 1; k <= 3 && (h.col - 1 + k) < row.length; k++) {
      var v = row[h.col - 1 + k];
      vals.push('col+' + k + '=' + show(v) + ' [' + typeOf(v) + ']');
    }
    var resolved = U.findValueRightOfLabel(sheet, label);
    Logger.log(
      (hits.length > 1 ? 'DUPE!  ' : 'FOUND  ') + 'Labels.' + key +
      '  @R' + h.row + 'C' + h.col +
      (hits.length > 1 ? '  (also at ' + hits.slice(1).map(function(x) {
        return 'R' + x.row + 'C' + x.col; }).join(', ') + ' - lookup uses FIRST)' : '') +
      '\n         neighbors: ' + (vals.join(' | ') || '(row too short!)') +
      '\n         lookup returns: ' + show(resolved) + ' [' + typeOf(resolved) + ']'
    );
  });

  // ---- 2. Near-miss hunt: cells that LOOK like the date label -----------
  Logger.log('==== 2. NEAR-MISS SCAN (cells containing "date" or "complet") ====');
  var wanted = String(L.expectedDate).toLowerCase().trim();
  for (var i2 = 0; i2 < data.length; i2++) {
    for (var j2 = 0; j2 < data[i2].length; j2++) {
      var cell = String(data[i2][j2]);
      var lc   = cell.toLowerCase();
      if (lc.indexOf('date') === -1 && lc.indexOf('complet') === -1) continue;
      if (cell.trim() === '') continue;
      var exact = (lc.trim() === wanted);
      Logger.log('R' + (i2 + 1) + 'C' + (j2 + 1) + (exact ? '  EXACT MATCH' : '  near-miss') +
                 '\n   cell   : ' + charCodes(cell) +
                 '\n   wanted : ' + charCodes(L.expectedDate) +
                 '\n   lengths: cell=' + cell.trim().length + ' wanted=' + wanted.length);
    }
  }

  // ---- 3. The expectedDate path end-to-end ------------------------------
  Logger.log('==== 3. EXPECTED-DATE PIPELINE ====');
  var raw = U.findValueRightOfLabel(sheet, L.expectedDate);
  Logger.log('raw from lookup : ' + show(raw) + ' [' + typeOf(raw) + ']');
  Logger.log('toIsoDate       : ' + show(U.toIsoDate(raw, tz)));
  Logger.log('would fail as   : ' +
    ((raw === null || raw === undefined || raw === '') ? 'MISSING (blank branch)'
     : (U.toIsoDate(raw, tz) === null ? 'MALFORMED (shape branch)' : 'PASSES')));
}


function probeLibraryVersion() { Logger.log('Container is executing SDC library,  ' + SDC.Version.LIBRARY)};