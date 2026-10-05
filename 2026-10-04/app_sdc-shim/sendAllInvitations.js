/**
 * Drop-in replacement for sendAllInvitations() in the config workbook shim (main.gs).
 * Replaces the hardcoded issue-invitations webhook with the library flow, which goes through the router.
 * sendInvitations() (selection-based) can be deleted: the selected-rows path is dead under the exclude-list
 * contract, and readSelectedSupplierRequestIds_ with it.
 */
function sendAllInvitations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var confirm = ui.alert('Send invitations', 'Send invitations to all pending suppliers?', ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  ss.toast('Sending invitations...', 'Status');
  var r = SDC.Invitations.run(ss);          // exclude list empty = everyone invitable
  ss.toast('');

  if (r.ok && r.data && r.data.results) {
    showInvitationResults_(r);
  } else {
    showResult_(r);
  }
}

/**
 * Per-supplier breakdown of an invitations batch. The shim referenced this from sendInvitations() but never
 * defined it; this is the missing renderer. Falls back to showResult_ when there is nothing to tabulate.
 */
function showInvitationResults_(r) {
  var results = (r.data && r.data.results) || [];
  if (!results.length) { showResult_(r); return; }

  var rows = results.map(function(x) {
    return '<tr><td>' + esc_(x.supplier_name || x.supplier_request_id || '') + '</td>' +
           '<td>' + esc_(x.status || x.outcome || '') + '</td>' +
           '<td>' + esc_(x.assignee || x.user_email || '') + '</td>' +
           '<td>' + esc_(x.message || x.error || '') + '</td></tr>';
  }).join('');

  var html = '<div style="font-family:Arial,sans-serif;font-size:13px">' +
    '<p>' + esc_(r.message) + '</p>' +
    '<table style="border-collapse:collapse;width:100%">' +
    '<tr><th align="left">Supplier</th><th align="left">Result</th><th align="left">Assignee</th><th align="left">Detail</th></tr>' +
    rows + '</table>' +
    '<p style="color:#666;margin-top:12px">Batch ' + esc_(r.correlationId) + '</p></div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(720).setHeight(480), 'Invitations sent');
}
