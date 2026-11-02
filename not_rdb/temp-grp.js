// --- Library access (interim, until the Google Group exists) ----------

/** Grant view access on every SDC library project to the emails listed in _library_access. */
function grantLibraryAccessFromList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIBRARY_ACCESS_SHEET);
  if (!sheet) {
    SpreadsheetApp.getUi().alert("'" + LIBRARY_ACCESS_SHEET + "' tab is missing. Add it with emails in column A (header in row 1).");
    return;
  }
  var emails = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues()
    .map(function(r) { return String(r[0] || '').trim().toLowerCase(); })
    .filter(function(e) { return e.indexOf('@') > 0; });
  grantLibraryAccess_(ss, emails, 'list');
}

/** Derive the list from the editors of every bound/active workbook in the registry, then grant. */
function grantLibraryAccessFromWorkbooks() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var settings = readSettings_(ss);
  var body = SDC.Registry.list(settings.registry);
  var emails = {};
  (body.workspaces || []).forEach(function(w) {
    if (!w.spreadsheet_id || (w.state !== 'bound' && w.state !== 'active')) return;
    try {
      DriveApp.getFileById(w.spreadsheet_id).getEditors().forEach(function(u) {
        var e = String(u.getEmail() || '').trim().toLowerCase();
        if (e) emails[e] = true;
      });
    } catch (e) {
      console.warn('Could not read editors of ' + w.spreadsheet_id + ': ' + e.message);
    }
  });
  grantLibraryAccess_(ss, Object.keys(emails), 'workbook editors');
}

/**
 * Idempotent: adds each email as a viewer on each library project it does not already have access to.
 * Runs as the current user, who must be able to share the library projects (owner or editor).
 */
function grantLibraryAccess_(ss, emails, sourceLabel) {
  var ui = SpreadsheetApp.getUi();
  var log = SDC.Log.forCorrelation(ss, SDC.Util.newCorrelationId());
  if (!emails.length) { ui.alert('No emails found (' + sourceLabel + ').'); return; }

  var added = [], skipped = 0, failed = [];
  SDC_LIBRARY_PROJECTS.forEach(function(lib) {
    var file;
    try { file = DriveApp.getFileById(lib.id); }
    catch (e) { failed.push(lib.name + ': cannot open project (' + e.message + ')'); return; }

    var existing = {};
    [file.getOwner()].concat(file.getEditors(), file.getViewers()).forEach(function(u) {
      if (u) existing[String(u.getEmail() || '').toLowerCase()] = true;
    });

    var toAdd = emails.filter(function(e) { return !existing[e]; });
    skipped += emails.length - toAdd.length;
    if (!toAdd.length) return;
    try {
      file.addViewers(toAdd);
      toAdd.forEach(function(e) { added.push(lib.name + ' ← ' + e); });
    } catch (e) {
      // Fall back to one-by-one so a single bad address does not block the rest.
      toAdd.forEach(function(email) {
        try { file.addViewer(email); added.push(lib.name + ' ← ' + email); }
        catch (e2) { failed.push(lib.name + ' ← ' + email + ': ' + e2.message); }
      });
    }
  });

  var summary = 'Source: ' + sourceLabel + ' (' + emails.length + ' emails)\n' +
    'Added: ' + added.length + '\nAlready had access: ' + skipped + '\nFailed: ' + failed.length +
    (failed.length ? '\n\n' + failed.join('\n') : '');
  log(failed.length ? 'WARN' : 'SUCCESS', 'Library access grant. ' + summary.replace(/\n/g, ' | '));
  ui.alert('Library access', summary, ui.ButtonSet.OK);
}
