/**
 * Health — a status check on one implementation workbook, assembled from what the library already knows.
 * No router involved, so it works in dry_run and in live mode alike. Each check is reported, never thrown, so
 * a broken workbook produces a readable report rather than a stack trace.
 *
 * Checks:
 *   schema      meta.schema_version vs the library (Migrations)
 *   binding     router.baseUrl / meta.workspace_key present (Config.build)        — "is this workbook routable?"
 *   customer    unresolved / healed named ranges (Customer.read)
 *   preflight   the provision gate (Preflight.run, requireCustomerData: true)      — "would provision start?"
 *   pack        meta.pack_id / pack_version / collection_mode / pack_applied_at    — "what shaped 4_fields?"
 *   fields      populated rows in 4_fields (FIELDS_LAYOUT)
 *   activity    last correlation id and the most recent _script_logs lines
 *   validation  last _validation_results overall verdict
 */
var Health = (function () {

  function check(spreadsheetId) {
    var out = { spreadsheetId: spreadsheetId, checks: [], url: null, name: null };
    var ss;
    try { ss = SpreadsheetApp.openById(spreadsheetId); out.url = ss.getUrl(); out.name = ss.getName(); }
    catch (e) { out.checks.push(row('open', false, 'Cannot open workbook: ' + e.message)); return out; }

    // schema
    var schema = safe(function () { return SDC.Migrations.currentWorkbookVersion(ss); });
    var needs  = safe(function () { return SDC.Migrations.isMigrationNeeded(ss); });
    out.checks.push(row('schema', schema.ok && needs.ok && !needs.value,
      schema.ok ? ('workbook ' + schema.value + ', library ' + SDC.Version.SCHEMA + (needs.value ? ' — migration needed' : '')) : schema.error));

    // config + binding
    var cfg = safe(function () { return SDC.Config.build(ss); });
    if (!cfg.ok) { out.checks.push(row('config', false, cfg.error)); return out; }
    var config = cfg.value;
    var boundOk = !!(config.router.baseUrl && config.router.workspaceKey);
    out.checks.push(row('binding', boundOk, boundOk
      ? 'workspace ' + config.router.workspaceKey + ' via ' + config.router.baseUrl
      : 'not bound — router.baseUrl / meta.workspace_key blank (claim has not run)'));
    out.workspaceKey = config.router.workspaceKey || null;

    // customer
    var cust = safe(function () { return SDC.Customer.read(ss, config); });
    if (cust.ok) {
      var un = cust.value.unresolved.map(function (u) { return u.key; });
      out.checks.push(row('customer', un.length === 0,
        un.length ? 'unresolved: ' + un.join(', ') : 'all ' + SDC.CUSTOMER_FIELDS.length + ' fields resolved' +
        (cust.value.healed.length ? ' (healed: ' + cust.value.healed.join(', ') + ')' : '')));
      out.customer = { clientName: cust.value.values.clientName, analystEmail: cust.value.values.analystEmail, targetVms: cust.value.values.targetVms };
    } else out.checks.push(row('customer', false, cust.error));

    // preflight — the provision gate
    var pf = safe(function () { return SDC.Preflight.run(ss, config, { requireCustomerData: true }); });
    out.checks.push(row('preflight', pf.ok, pf.ok ? 'passes; provision would start' : pf.error));

    // pack stamps + fields
    var meta = devMeta_(ss);
    out.checks.push(row('pack', !!meta.pack_id, meta.pack_id
      ? meta.pack_id + ' v' + meta.pack_version + ' (' + (meta.collection_mode || 'standard') + ', ' + meta.pack_applied_at + ')'
      : 'no pack applied'));
    var fields = safe(function () { return fieldRowCount_(ss, config); });
    out.checks.push(row('fields', fields.ok && fields.value > 0, fields.ok ? fields.value + ' field rows in ' + config.sheets.fields : fields.error));

    // activity + last validation
    var cid = safe(function () { return SDC.Log.getMostRecentCorrelationId(ss); });
    out.lastCorrelationId = cid.ok ? cid.value : null;
    out.recentLog = recentLog_(ss, 8);
    var vr = lastValidation_(ss);
    out.checks.push(row('validation', vr.overall ? /pass/i.test(vr.overall) : null, vr.overall ? vr.overall + ' at ' + vr.runAt : 'no validation run recorded'));

    out.ok = out.checks.every(function (c) { return c.ok !== false; });
    return out;
  }

  // --- helpers ------------------------------------------------------------------------------------------------------
  function row(name, ok, detail) { return { name: name, ok: ok, detail: detail }; }
  function safe(fn) { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: String(e.message || e) }; } }

  function devMeta_(ss) {
    var sh = ss.getSheetByName('_developer_settings'), out = {};
    if (!sh) return out;
    sh.getDataRange().getValues().forEach(function (r) { if (r[1] === 'meta') out[r[2]] = r[3]; });
    return out;
  }

  function fieldRowCount_(ss, config) {
    var sh = ss.getSheetByName(config.sheets.fields);
    if (!sh) throw new Error(config.sheets.fields + ' is missing');
    var L = SDC.FIELDS_LAYOUT, last = sh.getLastRow();
    if (last < L.DATA_START + 1) return 0;
    return sh.getRange(L.DATA_START + 1, L.FIELD_NAME_COL + 1, last - L.DATA_START, 1).getValues()
      .filter(function (r) { return String(r[0]).trim() !== ''; }).length;
  }

  function recentLog_(ss, n) {
    var sh = ss.getSheetByName('_script_logs');
    if (!sh || sh.getLastRow() < 2) return [];
    var start = Math.max(2, sh.getLastRow() - n + 1);
    return sh.getRange(start, 1, sh.getLastRow() - start + 1, 5).getValues().reverse().map(function (r) {
      return { at: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), status: r[1], user: r[2], message: r[3], correlationId: r[4] };
    });
  }

  function lastValidation_(ss) {
    var sh = ss.getSheetByName('_validation_results');
    if (!sh || sh.getLastRow() < 2) return {};
    var r = sh.getRange(2, 1, 1, 3).getValues()[0];         // Run At | Correlation ID | Overall (sheet is cleared before each write)
    return { runAt: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), correlationId: r[1], overall: String(r[2] || '') };
  }

  return { check: check };
})();
