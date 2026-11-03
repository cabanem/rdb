/**
 * @file 000_ValidationReport.gs
 * Writes a validate-flow verdict to the workbook's _validation_results sheet.
 * Sibling to Log: library-owned sheet, self-healing schema, best-effort write.
 *
 * One row per finding:
 *   - a check WITH details (fail/warn) emits one row per detail
 *   - a check with NO details emits one summary row
 *
 * Not in CONNECTOR_SHEETS, so it is never serialized to the config JSON.
 *
 * Public:
 *   ValidationReport.resolve(parsed)                  -> { verdict, formChannel }
 *   ValidationReport.write(ss, parsed, correlationId) -> { ok, rowsWritten }
 *   ValidationReport.ensureSchema(ss)                 -> void
 */
var ValidationReport = {};

var VR_SHEET_NAME         = '_validation_results';
var VR_CLEAR_BEFORE_WRITE = true;

var VR_HEADERS = Object.freeze([
  'Run At', 'Correlation ID', 'Overall', 'Check', 'Severity',
  'Message', 'Entity', 'Name', 'Issue'
]);

/**
 * Resolve everything a flow needs from a raw endpoint body, exactly once:
 *   verdict     - the checks[]-bearing verdict with the form-channel synthetic check merged in (see FormChannel.mergeIntoVerdict). 
 *                 May be null when the body carries neither a verdict nor a form-channel block.
 *   formChannel - normalized { status, detail } for callers that want the raw viability data (Result.data, future container UI), or null.
 *
 * Both write() and the flows resolve through this same function, so the sheet, the modal, and Result.data can never disagree about a finding.
 */
ValidationReport.resolve = function(parsed) {
  var verdict     = ValidationReport._extractVerdict(parsed);
  var formChannel = FormChannel.extract(parsed);
  return {
    verdict:     FormChannel.mergeIntoVerdict(verdict, formChannel),
    formChannel: formChannel
  };
};

ValidationReport.write = function(ss, parsed, correlationId) {
  try {
    if (!ss) return { ok: false, rowsWritten: 0, reason: 'no-spreadsheet', detail: '' };

    var verdict = ValidationReport.resolve(parsed).verdict;
    if (!verdict) {
      // Name the shape we received, so envelope drift is diagnosable from _script_logs.
      var keys = (parsed && typeof parsed === 'object') ? Object.keys(parsed).join(', ') : String(parsed);
      return { ok: false, rowsWritten: 0, reason: 'no-verdict',
               detail: 'No checks[] or form_channel at any known location. Top-level keys: [' + keys + ']' };
    }

    ValidationReport.ensureSchema(ss);
    var sheet = ss.getSheetByName(VR_SHEET_NAME);
    if (!sheet) {
      return { ok: false, rowsWritten: 0, reason: 'sheet-unavailable',
               detail: 'ensureSchema could not create/locate ' + VR_SHEET_NAME + ' (see Executions panel for warning).' };
    }

    var rows = ValidationReport._toRows(verdict, correlationId);

    if (VR_CLEAR_BEFORE_WRITE) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        sheet.getRange(2, 1, lastRow - 1, VR_HEADERS.length).clearContent();
      }
    }
    if (rows.length > 0) {
      var startRow = VR_CLEAR_BEFORE_WRITE ? 2 : sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, rows.length, VR_HEADERS.length).setValues(rows);
    }
    return { ok: true, rowsWritten: rows.length };
  } catch (e) {
    console.warn('ValidationReport.write failed: ' + e.message);
    return { ok: false, rowsWritten: 0 };
  }
};

ValidationReport.ensureSchema = function(ss) {
  try {
    if (!ss) return;
    var sheet = ss.getSheetByName(VR_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(VR_SHEET_NAME);
      sheet.getRange(1, 1, 1, VR_HEADERS.length).setValues([VR_HEADERS.slice()]);
      sheet.setFrozenRows(1);
      return;  // left visible on purpose - the analyst is meant to read it
    }
    var needed  = VR_HEADERS.length;
    var lastCol = sheet.getLastColumn();
    if (lastCol < needed) sheet.insertColumnsAfter(Math.max(lastCol, 1), needed - lastCol);

    var headerRange = sheet.getRange(1, 1, 1, needed);
    var current = headerRange.getValues()[0].map(function(v) { return String(v).trim(); });
    var rewrite = false;
    for (var i = 0; i < needed; i++) { if (current[i] !== VR_HEADERS[i]) { rewrite = true; break; } }
    if (rewrite) headerRange.setValues([VR_HEADERS.slice()]);
  } catch (e) {
    console.warn('ValidationReport.ensureSchema failed: ' + e.message);
  }
};

/**
 * Bring _validation_results to the front with the cursor near the top of the page. Un-hides the sheet
 * before activation (activating a hidden sheet throws).
 */
ValidationReport.activate = function(ss) {
  try {
    if (!ss) return false;
    var sheet = ss.getSheetByName(VR_SHEET_NAME);

    if (!sheet) return false;
    if (sheet.isSheetHidden()) sheet.showSheet();

    // Switch visible tab and scroll to the top
    sheet.getRange('A2').activate();
    return true;
  } catch (e) {
    console.warn('ValidationReport.activate failed: ' + e.message);
    return false;
  }
}
// The verdict object (status + checks[] + warnings[]) has been seen at several wire locations depending on
// how the endpoint's response schema is shaped. Try each known location and accept the first that looks like
// a verdict (carries a checks array). Returning the SAME object the modal reads keeps the in-sheet report and
// showValidationResults_ in agreement. If none match, return null - the caller surfaces that as a warning rather
// than writing a misleading empty/zero-row result.
//
// Form-channel note: this function stays a pure verdict-finder. The form-channel
// block rides NEXT TO the verdict on the wire (parsed.form_channel on provision,
// verdict.form_channel on validate) and is folded in one level up, by resolve().
ValidationReport._extractVerdict = function(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  var r = parsed.response || {};            // guard: parsed.response may be absent
  var candidates = [
    parsed.verdict,            // Preview + original Validate contract
    r.validate_summary,        // Validate "response" envelope
    parsed.validate_summary,   // top-level validate_summary
    parsed                     // fully flat
  ];

  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (v && typeof v === 'object' && Array.isArray(v.checks)) return v;
  }
  return null;
};

ValidationReport._toRows = function(verdict, correlationId) {
  var model = ValidationReport.toModel(verdict);
  var runAt = new Date();
  var cid   = String(correlationId || '');
  var rows  = [];

  model.checks.forEach(function(c) {
    if (c.details.length === 0) {
      rows.push([runAt, cid, model.overall, c.checkName, c.severity, c.message, '', '', '']);
    } else {
      c.details.forEach(function(d) {
        rows.push([runAt, cid, model.overall, c.checkName, c.severity, c.message,
                   d.entity, d.name, d.issue]);
      });
    }
  });
  return rows;
};

/**
 * Normalize a verdict into a presentation-neutral model. Single source of truth for "what does this
 * verdict actually say"; consumed by both the in-sheet writer (_toRows flattens it) and the modal (renders it grouped),
 * so the two can never disagree about a finding.
 *
 * @param {Object} verdict - From ValidationReport.resolve (or _extractVerdict).
 * @returns {{overall: string,
 *            checks: Array<{checkName: string, severity: string, message: string,
 *                           details: Array<{entity: string, name: string, issue: string}>}>}}
 */
ValidationReport.toModel = function(verdict) {
  if (!verdict || typeof verdict !== 'object') return { overall: '', checks: [] };

  var detailed = {};
  (verdict.warnings || []).forEach(function(w) {
    detailed[String(w.check_name || '')] = w;
  });

  var checks = (verdict.checks || []).map(function(c) {
    var checkName = String(c.check_name || '');
    var severity  = String(c.c_status || c.status || '');
    var w         = detailed[checkName];

    // Same finding-source resolution _toRows used to own.
    var source     = Array.isArray(c.details) ? c
                   : (w && Array.isArray(w.details)) ? w
                   : c;
    var rawDetails = Array.isArray(source.details) ? source.details : [];
    var message    = String(source.message || c.message || '');

    return {
      checkName: checkName,
      severity:  severity,
      message:   message,
      details:   rawDetails.map(function(d) {
        return { entity: String(d.entity || ''),
                 name:   String(d.name   || ''),
                 issue:  String(d.issue  || '') };
      })
    };
  });

  return { overall: String(verdict.status || ''), checks: checks };
};