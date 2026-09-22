/**
 * Field pack wrappers (library identifier: SDC). v0 flow with no HTML: pick a pack, answer its questions with
 * Yes/No alerts, choose the mode, apply. Replaces 4_fields, 4_complex_validations and 5_lookups in THIS workbook.
 * The sidebar version reuses SDC.Packs.list / SDC.Packs.apply unchanged.
 */
function setupFromPack() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  var config = SDC.Config.build(ss);
  var packs  = SDC.Packs.list(config);
  if (!packs.length) { ui.alert('No field packs', 'No packs found in the packs folder (storage.packsFolderId).', ui.ButtonSet.OK); return; }

  var menu = packs.map(function (p, i) { return (i + 1) + '. ' + p.vms + ' / ' + p.record_type + '  (v' + p.pack_version + ')'; }).join('\n');
  var pick = ui.prompt('Set up from field pack', 'Which pack?\n\n' + menu + '\n\nEnter the number:', ui.ButtonSet.OK_CANCEL);
  if (pick.getSelectedButton() !== ui.Button.OK) return;
  var idx = parseInt(pick.getResponseText(), 10) - 1;
  if (!(idx >= 0 && idx < packs.length)) { ui.alert('Not a valid choice.'); return; }
  var pack = SDC.Packs.read(packs[idx].fileId);

  // tenant questions: one Yes/No each (the sidebar shows them together)
  var answers = {}, seen = {};
  pack.questions.forEach(function (q) {
    if (seen[q.question_id]) return; seen[q.question_id] = true;
    answers[q.question_id] = ui.alert(q.question_id, q.prompt, ui.ButtonSet.YES_NO) === ui.Button.YES;
  });

  var mode = ui.alert('Collection mode',
    'YES = Standard (failures reject the row where Strict? is ticked).\nNO = Discovery (nothing is rejected; failures are reported).',
    ui.ButtonSet.YES_NO) === ui.Button.YES ? 'standard' : 'discovery';

  var replace = false;
  var check = ui.alert('Replace current fields?', 'This replaces everything in 4_fields, 4_complex_validations and 5_lookups. Continue?', ui.ButtonSet.YES_NO);
  if (check !== ui.Button.YES) return;
  replace = true;

  ss.toast('Applying pack...', 'Status');
  var r = SDC.Packs.apply(ss, { fileId: packs[idx].fileId, answers: answers, scope: null, mode: mode, replace: replace });
  ss.toast('');
  if (r.ok && r.data && r.data.validationResult) showValidationResults_(r.data.validationResult);
  else showResult_(r);
}
