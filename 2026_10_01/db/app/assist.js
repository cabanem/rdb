/**
 * @file assist.js (container-bound shim)
 * Config assistant wrappers. All logic lives in SDC.Assist (lib_sdc 012_Assist); this file only wires the
 * sidebar, the menu and the trigger.
 *
 * Menu (in onOpen, inside the Supplier data collection menu):
 *   .addSeparator()
 *   .addItem('Config assistant', 'assistOpen')
 *   .addItem('Build assistant corpus', 'assistBuildDigest')          // ops only; also the nightly trigger target
 *
 * Nightly trigger (one workbook only, e.g. the template workbook): Triggers > Add > assistBuildDigestScheduled, time-driven, daily.
 */

function assistOpen() {
  var html = HtmlService.createHtmlOutputFromFile('assist_sidebar')
    .setTitle('Config assistant')
    .setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Called by the sidebar on load. Plain object so it crosses google.script.run cleanly. */
function assistStatus() {
  return SDC.Assist.status(SpreadsheetApp.getActiveSpreadsheet());
}

/**
 * Called by the sidebar per question. Returns the Result's user-facing parts only.
 * @param {string} question
 * @param {boolean} includeFindings  the sidebar checkbox; undefined -> _developer_settings default
 */
function assistAsk(question, includeFindings) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var opts = (includeFindings === undefined || includeFindings === null) ? {} : { includeFindings: !!includeFindings };
  var r = SDC.Assist.ask(ss, question, opts);
  return {
    ok: r.ok,
    message: r.message,
    answer: r.data ? r.data.answer : '',
    builtAt: r.data ? r.data.builtAt : '',
    durationMs: r.data ? r.data.durationMs : null,
    findingsIncluded: r.data ? r.data.findingsIncluded : false,
    warnings: r.warnings || [],
    error: r.error
  };
}

/** Menu entry: rebuild the digest now and say what happened. */
function assistBuildDigest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  try {
    var config = SDC.Config.build(ss);
    var out = SDC.Assist.buildDigest(config, { force: false });
    SDC.Log.append(ss, 'INFO', 'Assistant corpus ' + out.reason + ' (' + out.sources.length + ' source(s), ' + out.bytes + ' bytes, ' + out.fingerprint.substring(0, 12) + ').');
    ui.alert('Assistant corpus', out.built
      ? 'Rebuilt from ' + out.sources.length + ' source(s):\n' + out.sources.join('\n')
      : 'Unchanged since the last build (' + out.sources.length + ' source(s)).', ui.ButtonSet.OK);
  } catch (e) {
    SDC.Log.append(ss, 'ERROR', 'Assistant corpus build failed at ' + (e.stage || 'unknown') + ': ' + e.message);
    ui.alert('Assistant corpus', 'Build failed: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Trigger target: headless, no UI. Logs to _script_logs of the workbook that owns the trigger. */
function assistBuildDigestScheduled() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    var out = SDC.Assist.buildDigest(SDC.Config.build(ss), { force: false });
    if (out.built) SDC.Log.append(ss, 'INFO', 'Assistant corpus ' + out.reason + ' (' + out.sources.length + ' source(s), ' + out.bytes + ' bytes).');
  } catch (e) {
    SDC.Log.append(ss, 'ERROR', 'Scheduled assistant corpus build failed at ' + (e.stage || 'unknown') + ': ' + e.message);
  }
}
