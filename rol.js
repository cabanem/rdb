/**
 * @file RecipeOrder — generates RTR_RecipeOrder from golden
 * @description Reads golden's recipe set and call graph, levels it, and replaces the router's
 *              RTR_RecipeOrder table wholesale. Lives beside the other estate runners in the
 *              DataBridge inventory app. Never filters; never merges; never hand-edited output.
 *
 *              Libraries (same symbols as the Watchdog observer):
 *                WorkatoLib       - Developer API client (get/post/delete/fetchPaginated)
 *                WorkatoGraphLib  - call-edge extraction from recipe code
 *                WorkatoOrderLib  - buildCorpusGraph / levels / fingerprint / diffEdges (>= 0.3.0)
 *
 *              Three entry points, all menu-safe:
 *                recipeOrderPreview()  - compute rows, write them to the RecipeOrder tab, touch no table.
 *                recipeOrderRebuild()  - compute rows, then replace RTR_RecipeOrder in every router target.
 *                recipeOrderDiagnose() - "why won't it order": non-strict pass, every finding to the
 *                                        RecipeOrderFindings tab with recipe names resolved. Touches nothing.
 *
 *              The table's contract (see the handoff): recipe_name (string, golden's exact name),
 *              position (integer, ascending start order; ties allowed), callable (boolean).
 *              POOL-14 is the only reader and refuses to start anything on a bidirectional mismatch,
 *              so a partial write is safe by construction — it can only ever stop a register.
 *
 * Script properties:
 *   WORKATO_DEV_TOKEN      golden's DEV token (read-only use here)
 *   WORKATO_BASE_URL       e.g. https://app.eu.workato.com/api  (defaults to that)
 *   GOLDEN_FOLDER_ID       root folder of the golden project; walked recursively
 *   RECIPE_ORDER_SHEET_ID  spreadsheet for the RecipeOrder + RecipeOrderLog tabs (defaults to the active sheet)
 *   RTR_TARGETS            JSON: [{ "label": "TEST", "token_prop": "ROUTER_TEST_TOKEN", "table_id": "..." }, ...]
 *                          one entry per router environment that holds an RTR_RecipeOrder table.
 *                          Data-table ROWS are per environment in Workato, so TEST and PROD are two writes.
 *
 * @author emily.cabaniss@randstadsourceright.com
 * @version 0.1.0
 */

// -------------------------------------------------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------------------------------------------------

function roCfg_() {
  var p = PropertiesService.getScriptProperties();
  return {
    devToken:  p.getProperty('WORKATO_DEV_TOKEN'),
    baseUrl:   p.getProperty('WORKATO_BASE_URL') || 'https://app.eu.workato.com/api',
    goldenFolderId: p.getProperty('GOLDEN_FOLDER_ID'),
    sheetId:   p.getProperty('RECIPE_ORDER_SHEET_ID'),
    targets:   JSON.parse(p.getProperty('RTR_TARGETS') || '[]').map(function (t) {
      var token = p.getProperty(t.token_prop);
      if (!token) throw new Error('RTR_TARGETS "' + t.label + '": script property ' + t.token_prop + ' is not set.');
      return { label: t.label, token: token, tableId: String(t.table_id) };
    })
  };
}

var RO_TABLE_HEADER = ['recipe_name', 'position', 'callable', 'recipe_id', 'level_size'];
var RO_LOG_HEADER   = ['at', 'action', 'ok', 'recipe_count', 'level_count', 'row_fingerprint', 'edge_fingerprint', 'changed', 'detail'];

// -------------------------------------------------------------------------------------------------------
// ENTRY POINTS
// -------------------------------------------------------------------------------------------------------

/** Compute and show. Writes nothing to Workato. */
function recipeOrderPreview() { return roRun_('preview'); }

/** Compute, then replace RTR_RecipeOrder in every configured router target. */
function recipeOrderRebuild() { return roRun_('rebuild'); }

function roRun_(action) {
  var cfg = roCfg_();
  var ss = cfg.sheetId ? SpreadsheetApp.openById(cfg.sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  try {
    var result = roCompute_(cfg);
    var prev = roReadLast_(ss);
    result.changed = !prev || prev.row_fingerprint !== result.rowFingerprint;
    result.edgeDiff = prev && prev.edges ? RO_orderer_().diffEdges(prev.edges, result.edges) : null;

    roWriteTab_(ss, result);

    var detail = roDescribe_(result);
    if (action === 'rebuild') {
      if (!cfg.targets.length) throw new Error('RTR_TARGETS is empty; nothing to write to.');
      cfg.targets.forEach(function (t) {
        var client = WorkatoLib.newClient(t.token, cfg.baseUrl);
        var w = roReplaceTable_(client, t.tableId, result.rows);
        detail += '\n' + t.label + ': deleted ' + w.deleted + ', inserted ' + w.inserted;
      });
    }

    roLog_(ss, action, true, result, detail);
    Logger.log(detail);
    return result;
  } catch (e) {
    var msg = String(e && e.message || e);
    if (e && e.findings && e.findings.length) {
      msg += '\n' + e.findings.map(function (f) { return '[' + f.code + '] ' + f.detail; }).join('\n');
    }
    roLog_(ss, action, false, null, msg);
    Logger.log(msg);
    throw e;
  }
}

/** Why won't it order? Same fetch, orderer in non-strict mode, every finding listed by recipe name. */
function recipeOrderDiagnose() {
  var cfg = roCfg_();
  var ss = cfg.sheetId ? SpreadsheetApp.openById(cfg.sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  var client = WorkatoLib.newClient(cfg.devToken, cfg.baseUrl, { dryRun: true });
  var corpus = roFetchCorpus_(client, cfg.goldenFolderId);
  var analyzer = WorkatoGraphLib.newAnalyzer(client, { STRICT: true });
  analyzer.primeCache(corpus.recipes);

  var nameById = {};
  corpus.recipes.forEach(function (r) { nameById[String(r.id)] = r.name || ''; });
  var manifest = corpus.recipes.map(function (r) { return { id: String(r.id), name: r.name }; });
  var graph = WorkatoOrderLib.newOrderer({ strict: false }).buildCorpusGraph(analyzer, manifest);

  var header = ['level', 'code', 'recipe', 'detail'];
  var rows = graph.findings.map(function (f) {
    var m = /^(\d+)/.exec(String(f.detail || ''));            // findings lead with the caller's id
    return [f.level, f.code, m ? (nameById[m[1]] || m[1]) : '', f.detail];
  });
  var sh = roSheet_(ss, 'RecipeOrderFindings', header);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, header.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);

  var text = rows.length
    ? rows.map(function (r) { return '[' + r[0] + '] ' + r[1] + ' ' + r[2] + ' — ' + r[3]; }).join('\n')
    : 'no findings; ' + corpus.recipes.length + ' recipes, ' + graph.edges.length + ' edges';
  Logger.log(text);
  return graph.findings;
}

// -------------------------------------------------------------------------------------------------------
// COMPUTE (I/O in, pure out)
// -------------------------------------------------------------------------------------------------------

function RO_orderer_() { return WorkatoOrderLib.newOrderer({ strict: true }); }

/** Fetch golden, derive the graph, level it, shape rows. Throws on anything that would make the table a lie. */
function roCompute_(cfg) {
  var client = WorkatoLib.newClient(cfg.devToken, cfg.baseUrl, { dryRun: true });
  var corpus = roFetchCorpus_(client, cfg.goldenFolderId);

  var analyzer = WorkatoGraphLib.newAnalyzer(client, { STRICT: true });
  analyzer.primeCache(corpus.recipes);

  var result = buildRecipeOrder(corpus.recipes, analyzer, RO_orderer_());
  result.crossCheck = roCrossCheckManifest_(client, cfg.goldenFolderId, result);
  return result;
}

/**
 * The pure core. Testable with a primed analyzer and any Orderer.
 *
 * @param {Array<Object>} recipes  - list-endpoint objects for every recipe in the golden folder tree (with code)
 * @param {Object} analyzer        - WorkatoGraphLib analyzer, cache primed with those recipes
 * @param {Object} orderer         - WorkatoOrderLib orderer (strict)
 * @returns {{rows, levels, edges, nodes, recipeCount, levelCount, rowFingerprint, edgeFingerprint, findings}}
 */
function buildRecipeOrder(recipes, analyzer, orderer) {
  // 1. Manifest: every recipe, no exclusions. Name is the join key, so duplicates are fatal here.
  var byName = {};
  recipes.forEach(function (r) {
    var n = String(r.name || '').trim();
    if (!n) throw new Error('Recipe ' + r.id + ' has an empty name; POOL-14 joins on name.');
    (byName[n] = byName[n] || []).push(String(r.id));
  });
  var dups = Object.keys(byName).filter(function (n) { return byName[n].length > 1; });
  if (dups.length) {
    throw new Error('Duplicate recipe names in golden (join key must be unique): ' +
      dups.map(function (n) { return n + ' [' + byName[n].join(', ') + ']'; }).join('; '));
  }
  var manifest = recipes.map(function (r) { return { id: String(r.id), name: r.name }; });

  // 2. Graph. Strict orderer already refuses dynamic / unresolved callees. An EXTERNAL_CALLEE is only a
  //    warning for the Watchdog (the fleet may legitimately call outside the managed set); for this table
  //    it is fatal: a callee outside golden will not be in the package, so the caller can never run.
  var graph = orderer.buildCorpusGraph(analyzer, manifest);
  var external = graph.findings.filter(function (f) { return f.code === 'EXTERNAL_CALLEE'; });
  if (external.length) {
    var err = new Error('Call edges leave the golden folder (' + external.length + '); prune or move the callee.');
    err.findings = external;
    throw err;
  }

  // 3. Levels (Kahn rounds). Cycle -> OrderingError naming the members; nothing is emitted.
  var levels = orderer.levels(graph.nodes, graph.edges);

  // 4. callable = the trigger is a recipe-function trigger (the root of recipe.code).
  var meta = {};
  recipes.forEach(function (r) {
    var code = (typeof r.code === 'string') ? JSON.parse(r.code) : (r.code || {});
    meta[String(r.id)] = {
      name: r.name,
      callable: analyzer.CONSTANTS.RECIPE_PROVIDERS.indexOf(String(code.provider || '')) !== -1
    };
  });

  // 5. Rows. position = level index (1-based) — exactly what the graph says, nothing more.
  //    Row ORDER within a level is callable-first then name, so the sheet and the table read the same
  //    way run after run; it carries no meaning POOL-14 depends on.
  var rows = [];
  levels.forEach(function (ids, i) {
    ids.map(function (id) { return { recipe_name: meta[id].name, position: i + 1, callable: meta[id].callable, recipe_id: id, level_size: ids.length }; })
       .sort(function (a, b) {
         if (a.callable !== b.callable) return a.callable ? -1 : 1;
         return a.recipe_name < b.recipe_name ? -1 : (a.recipe_name > b.recipe_name ? 1 : 0);
       })
       .forEach(function (row) { rows.push(row); });
  });

  // 6. Two fingerprints. Edge fingerprint is the Orderer's (drift log, diffEdges). Row fingerprint is over
  //    what the table will contain — it moves on a rename or a trigger change even when no edge moved,
  //    which is what "does the table need rebuilding" actually asks.
  var canonicalRows = rows.map(function (r) { return r.recipe_name + '|' + r.position + '|' + r.callable; }).sort().join('\n');

  return {
    rows: rows,
    levels: levels,
    edges: graph.edges,
    nodes: graph.nodes,
    findings: graph.findings,
    recipeCount: rows.length,
    levelCount: levels.length,
    edgeFingerprint: orderer.fingerprint(graph.edges),
    rowFingerprint: orderer.options.sha256(canonicalRows)
  };
}

/** Same walk as the Watchdog's fetchCorpus_: root folder + every sub-folder, recipes deduped by id. */
function roFetchCorpus_(client, rootFolderId) {
  if (!rootFolderId) throw new Error('GOLDEN_FOLDER_ID is not set.');
  var folderIds = [String(rootFolderId)];
  var queue = [String(rootFolderId)];
  while (queue.length) {
    var parent = queue.shift();
    client.fetchPaginated('folders?parent_id=' + parent).forEach(function (f) {
      folderIds.push(String(f.id));
      queue.push(String(f.id));
    });
  }
  var recipes = [], seen = {};
  folderIds.forEach(function (fid) {
    client.fetchPaginated('recipes?folder_id=' + fid).forEach(function (r) {
      var k = String(r.id);
      if (!seen[k]) { seen[k] = true; recipes.push(r); }
    });
  });
  return { folderIds: folderIds, recipes: recipes };
}

/**
 * Cross-check against RLCM's view: the manifest listing's recipe->recipe deps should equal our edge set.
 * Differences are LOGGED, never fatal — this is Workato's dependency view, not the step tree. The check is
 * skipped (and says so) if the endpoint shape does not match what we expect, so it can never block a rebuild.
 */
function roCrossCheckManifest_(client, folderId, result) {
  try {
    var listing = client.get('export_manifests/folder_assets?folder_id=' + folderId);
    var assets = Array.isArray(listing) ? listing : (listing.result || listing.assets || []);
    var recipeAssets = assets.filter(function (a) { return String(a.type || '').toLowerCase() === 'recipe'; });
    if (!recipeAssets.length) return { status: 'skipped', detail: 'no recipe assets in listing' };

    var idByName = {};
    result.rows.forEach(function (r) { idByName[r.recipe_name] = r.recipe_id; });
    var theirs = new Set();
    recipeAssets.forEach(function (a) {
      (a.deps || []).filter(function (d) { return String(d.type || '').toLowerCase() === 'recipe'; }).forEach(function (d) {
        var from = idByName[a.name], to = idByName[d.name];
        if (from && to) theirs.add(from + '->' + to);
      });
    });
    var ours = new Set(result.edges.map(function (e) { return e[0] + '->' + e[1]; }));
    var onlyOurs = [...ours].filter(function (k) { return !theirs.has(k); });
    var onlyTheirs = [...theirs].filter(function (k) { return !ours.has(k); });
    return { status: (onlyOurs.length || onlyTheirs.length) ? 'differs' : 'agrees', onlyInCode: onlyOurs, onlyInManifest: onlyTheirs };
  } catch (e) {
    return { status: 'skipped', detail: String(e && e.message || e) };
  }
}

// -------------------------------------------------------------------------------------------------------
// WRITE PATH — Developer API data-table records
// -------------------------------------------------------------------------------------------------------
//
// !! Endpoint shapes to confirm against your Data Tables connector before the first rebuild. What is
//    assumed here: the table's schema exposes its columns with an id and a name; records come back as
//    { record_id, document } with document keyed by column id; create takes one record; delete is per
//    record. Change these four functions only — nothing above them cares how the write happens.
//
// Order of operations is deliberate: the sort has already succeeded before we get here, and delete-all
// runs before insert, so the table is either untouched, empty+partial (POOL-14 refuses), or complete.

function roReplaceTable_(client, tableId, rows) {
  var columns = roTableColumns_(client, tableId);           // { recipe_name: <col id>, ... }
  RO_TABLE_HEADER.slice(0, 3).forEach(function (c) {
    if (!columns[c]) throw new Error('RTR_RecipeOrder (' + tableId + ') has no column "' + c + '"');
  });

  var existing = roListRecords_(client, tableId);
  existing.forEach(function (rec) { client.delete('data_tables/' + tableId + '/records/' + rec.record_id); });

  rows.forEach(function (r) {
    var doc = {};
    doc[columns.recipe_name] = r.recipe_name;
    doc[columns.position]    = r.position;
    doc[columns.callable]    = r.callable;
    client.post('data_tables/' + tableId + '/records', { data: doc });
  });
  return { deleted: existing.length, inserted: rows.length };
}

/** name -> column id. */
function roTableColumns_(client, tableId) {
  var table = client.get('data_tables/' + tableId);
  var schema = table.schema || table.columns || (table.data && table.data.schema) || [];
  var out = {};
  schema.forEach(function (c) { out[c.name] = c.field_id || c.id || c.name; });
  return out;
}

/** Every record, following the continuation token. */
function roListRecords_(client, tableId) {
  var out = [], token = null, guard = 0;
  do {
    var res = client.get('data_tables/' + tableId + '/records' + (token ? '?continuation_token=' + encodeURIComponent(token) : ''));
    (res.data || res.records || []).forEach(function (r) { out.push(r); });
    token = res.continuation_token || null;
  } while (token && ++guard < 100);
  return out;
}

// -------------------------------------------------------------------------------------------------------
// SHEET PLUMBING (RecipeOrder tab = the human read; RecipeOrderLog = one row per run)
// -------------------------------------------------------------------------------------------------------

function roWriteTab_(ss, result) {
  var sh = roSheet_(ss, 'RecipeOrder', RO_TABLE_HEADER);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  if (result.rows.length) {
    sh.getRange(2, 1, result.rows.length, RO_TABLE_HEADER.length).setValues(
      result.rows.map(function (r) { return RO_TABLE_HEADER.map(function (k) { return r[k]; }); }));
  }
}

function roLog_(ss, action, ok, result, detail) {
  roSheet_(ss, 'RecipeOrderLog', RO_LOG_HEADER).appendRow([
    new Date(), action, ok,
    result ? result.recipeCount : '', result ? result.levelCount : '',
    result ? result.rowFingerprint : '', result ? result.edgeFingerprint : '',
    result ? result.changed : '', detail
  ]);
  if (ok && result) {
    PropertiesService.getScriptProperties().setProperty('RECIPE_ORDER_LAST', JSON.stringify({
      at: new Date().toISOString(), row_fingerprint: result.rowFingerprint,
      edge_fingerprint: result.edgeFingerprint, edges: result.edges
    }));
  }
}

function roReadLast_(ss) {
  var raw = PropertiesService.getScriptProperties().getProperty('RECIPE_ORDER_LAST');
  return raw ? JSON.parse(raw) : null;
}

function roDescribe_(result) {
  var lines = [
    result.recipeCount + ' recipes in ' + result.levelCount + ' levels; ' + result.edges.length + ' call edges',
    'row fingerprint ' + result.rowFingerprint + (result.changed ? ' (changed)' : ' (unchanged)'),
    'manifest cross-check: ' + result.crossCheck.status +
      (result.crossCheck.onlyInCode && result.crossCheck.onlyInCode.length ? '; only in code: ' + result.crossCheck.onlyInCode.join(', ') : '') +
      (result.crossCheck.onlyInManifest && result.crossCheck.onlyInManifest.length ? '; only in manifest: ' + result.crossCheck.onlyInManifest.join(', ') : '') +
      (result.crossCheck.detail ? ' (' + result.crossCheck.detail + ')' : '')
  ];
  if (result.edgeDiff && (result.edgeDiff.added.length || result.edgeDiff.removed.length)) {
    lines.push('edges added: ' + result.edgeDiff.added.join(', ') + '; removed: ' + result.edgeDiff.removed.join(', '));
  }
  var byLevel = result.levels.map(function (ids, i) {
    return 'L' + (i + 1) + ': ' + result.rows.filter(function (r) { return r.position === i + 1; }).map(function (r) { return r.recipe_name; }).join(', ');
  });
  return lines.concat(byLevel).join('\n');
}

function roSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}

if (typeof module !== 'undefined') module.exports = { buildRecipeOrder };
