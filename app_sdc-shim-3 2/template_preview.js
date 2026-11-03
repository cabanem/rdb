function previewTemplate() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Building template preview...', 'Status');   // before the call; it blocks
  var r = SDC.Preview.run(ss);
  ss.toast('');
  guideMark_('preview', r);

  if (!r.ok) { showResult_(r); return; }

  var d = r.data || {};
  if (d.fileContent) {
    showTemplatePreview_(d);                             // valid: download modal
    return;
  }

  // Only show the validation modal when the verdict actually says invalid.
  // A missing file with a passing/absent verdict is a build error, not a validation outcome.
  var verdict = d.validationResult || {};
  var status  = String(verdict.status || '').toLowerCase();
  if (status === 'invalid' || status === 'fail') {
    showValidationResults_(verdict);
  } else {
    showResult_(r);
  }
}

function showTemplatePreview_(data) {
  // Stash bytes server-side; modal fetches via google.script.run.
  var c = CacheService.getUserCache();
  c.put('preview_b64', data.fileContent || '', 300);
  c.put('preview_name', data.fileName || 'preview.xlsx', 300);

  var t = HtmlService.createTemplateFromFile('preview_template');
  //t.b64 = data.fileContent;
  t.filename  = data.fileName || 'preview.xlsx';
  t.meta     = data.metadata || {};
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(480).setHeight(300), 'Template preview');
}

function getPreviewBytes() {
  var c = CacheService.getUserCache();
  return { b64: c.get('preview_b64') || '', name: c.get('preview_name') || 'preview.xlsx'};
}