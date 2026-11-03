/**
 * Track 2 — cascade authoring assist
 * SDC dropdown / cascade redesign
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 *   1. Stamps a self-validating dropdown on the "Parent value" column of every
 *      cascade child block, sourced from the parent lookup's own values, with
 *      invalid entries hard-rejected. The analyst picks "Belgium"; "BE", "TRUE",
 *      and any other off-list string become unenterable.
 *   2. Stamps a dropdown on the "Depends on" column of 4_fields (the existing
 *      lookup-name cell — we are NOT moving it to a field reference yet), so the
 *      parent list can only be a real lookup name.
 *   3. Surfaces a completeness counter in a sidebar: mapped / total per cascade
 *      list, plus "fill parent first" for blocks whose parent list is empty and
 *      a readiness verdict. This is the catches-MISSING half; the dropdown is
 *      the catches-WRONG half.
 *
 * WHY IT CANNOT BREAK SERIALIZATION OR FIGHT sdc_lib
 *   - Data validations, cell notes, and the sidebar are metadata / UI. They are
 *     NOT cell values, and Drive.serializeConfig reads getValues() — so none of
 *     this reaches the JSON the connector parses.
 *   - It reads and writes BY HEADER NAME (via Track 1's helpers), never by index.
 *   - It defines NO reserved onOpen/onEdit. It installs its own *installable*
 *     triggers with unique handler names, so it coexists with sdc_lib's handlers.
 *
 * DEPENDENCY
 *   This file reuses Track 1 (sdc_track1_lookup_migration.gs): SDC_MIG,
 *   buildFieldCascadeMap_, verifyLookupParents, findHeaderRow_, headerMap_, trim_.
 *   Both files must live in the same Apps Script project.
 *
 * SETUP (once)
 *   Run installSdcTrack2Triggers().  Adds installable onOpen (menu) + onEdit
 *   (live re-stamp). If you would rather wire it into sdc_lib's own handlers,
 *   skip that and instead call sdcTrack2Menu() from sdc_lib's onOpen and
 *   sdcTrack2OnEdit(e) from sdc_lib's onEdit.
 *
 * USE
 *   Menu "SDC cascade" > Stamp dropdowns   -> stampCascadeDropdowns()
 *   Menu "SDC cascade" > Show completeness -> showTrack2Sidebar()
 */

function assertTrack1_() {
  if (typeof SDC_MIG === 'undefined' ||
      typeof buildFieldCascadeMap_ !== 'function' ||
      typeof verifyLookupParents !== 'function' ||
      typeof findHeaderRow_ !== 'function' ||
      typeof headerMap_ !== 'function' ||
      typeof trim_ !== 'function') {
    throw new Error('Track 2 needs the Track 1 file (sdc_track1_lookup_migration.gs) ' +
      'in the same Apps Script project — it reuses SDC_MIG, buildFieldCascadeMap_, ' +
      'verifyLookupParents, and the header helpers.');
  }
}

// --- Stamping ---------------------------------------------------------------

/** Public entry: stamp both the field-side and item-side dropdowns. */
function stampCascadeDropdowns(opts) {
  assertTrack1_();
  opts = opts || {};
  var ss = opts.ss || SpreadsheetApp.getActive();
  var item = stampParentDropdowns_(ss);
  var field = stampDependsOnDropdown_(ss);
  var summary = { parentDropdowns: item, dependsOnDropdown: field };
  Logger.log('stampCascadeDropdowns: ' + JSON.stringify(summary));
  try {
    var blockedN = Object.keys(item.blocked).length;
    ss.toast('Stamped ' + item.stamped + ' parent cells' +
      (blockedN ? ' (' + blockedN + ' list(s) blocked: fill parent first)' : ''),
      'SDC cascade', 5);
  } catch (e) {}
  return summary;
}

/** Item-side: dropdown on 5_lookups "Parent value", per cascade block. */
function stampParentDropdowns_(ss) {
  var childToParent = buildFieldCascadeMap_(ss).map;
  var sheet = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  if (!sheet) throw new Error('Sheet not found: ' + SDC_MIG.LOOKUPS_SHEET);

  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.table, H.value, H.parent]);
  if (hr === -1) throw new Error('Could not find the 5_lookups header row.');
  var hm = headerMap_(values[hr]);
  var cTable = hm[H.table], cValue = hm[H.value], cParent = hm[H.parent];

  var dataStart = hr + 1;
  var dataRows = values.length - dataStart;
  if (dataRows <= 0) return { stamped: 0, cleared: 0, blocked: {} };

  // ordered, de-duped value list per lookup (a parent's selectable values)
  var valueList = {}, seen = {};
  for (var r = dataStart; r < values.length; r++) {
    var ln = trim_(values[r][cTable]); if (!ln) continue;
    var v = trim_(values[r][cValue]); if (!v) continue;
    if (!valueList[ln]) { valueList[ln] = []; seen[ln] = {}; }
    if (!seen[ln][v]) { seen[ln][v] = true; valueList[ln].push(v); }
  }

  // one DataValidation per parent lookup, reused across that lookup's children
  var dvCache = {};
  function dvFor_(parentLookup) {
    if (parentLookup in dvCache) return dvCache[parentLookup];
    var list = valueList[parentLookup] || [];
    var dv = null;
    if (list.length > 0) {
      dv = SpreadsheetApp.newDataValidation()
        .requireValueInList(list, true)   // show the dropdown
        .setAllowInvalid(false)           // reject anything off-list (typed or pasted)
        .setHelpText('Pick a value from the "' + parentLookup + '" list.')
        .build();
    }
    dvCache[parentLookup] = dv;           // null = parent list still empty
    return dv;
  }

  var range = sheet.getRange(dataStart + 1, cParent + 1, dataRows, 1);
  var notes = range.getNotes();           // preserve notes on non-child cells
  var dvs = [];
  var stamped = 0, cleared = 0, blocked = {};

  for (var r2 = dataStart; r2 < values.length; r2++) {
    var i = r2 - dataStart;
    var ln2 = trim_(values[r2][cTable]);
    if (ln2 && childToParent[ln2]) {
      var pl = childToParent[ln2];
      var dv = dvFor_(pl);
      if (dv) {
        dvs.push([dv]); stamped++;
        notes[i][0] = '';                                 // clear stale hint
      } else {
        dvs.push([null]);                                 // empty parent: no dropdown
        notes[i][0] = 'Fill the "' + pl + '" list before mapping this row.';
        blocked[ln2] = pl;
      }
    } else {
      dvs.push([null]);                                   // root / flat: clear validation
      cleared++;                                          // leave its note untouched
    }
  }

  try {
    range.setDataValidations(dvs);
  } catch (err) {
    if (String(err).indexOf('typed columns') !== -1) {
      throw new Error('"Parent value" is a typed Table column. Set its column type to None/Text ' +
      '(or run untypeParentValueColumn()), then re-run. A typed column is column-uniform and cannot ' +
      'hold the per-row parent dropdowns a cascade requires.');
    }
    throw err;
  }
  range.setNotes(notes);
  return { stamped: stamped, cleared: cleared, blocked: blocked };
}

/** Field-side: dropdown on 4_fields "Depends on" = the set of lookup names. */
function stampDependsOnDropdown_(ss) {
  var fields = ss.getSheetByName(SDC_MIG.FIELDS_SHEET);
  if (!fields) throw new Error('Sheet not found: ' + SDC_MIG.FIELDS_SHEET);
  var fv = fields.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var fhr = findHeaderRow_(fv, [H.fieldLookup, H.fieldDependsOn]);
  if (fhr === -1) return { stamped: 0, reason: 'no 4_fields header' };
  var cDep = headerMap_(fv[fhr])[H.fieldDependsOn];

  var lk = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  var lv = lk.getDataRange().getValues();
  var lhr = findHeaderRow_(lv, [H.table, H.value, H.parent]);
  var cTable = headerMap_(lv[lhr])[H.table];

  var names = [], seen = {};
  for (var r = lhr + 1; r < lv.length; r++) {
    var n = trim_(lv[r][cTable]);
    if (n && !seen[n]) { seen[n] = true; names.push(n); }
  }
  if (!names.length) return { stamped: 0, reason: 'no lookup names' };

  var dv = SpreadsheetApp.newDataValidation()
    .requireValueInList(names, true)
    .setAllowInvalid(false)
    .setHelpText('Pick the parent list this field cascades from (blank = flat).')
    .build();

  var fStart = fhr + 1;
  var n2 = fv.length - fStart;
  if (n2 <= 0) return { stamped: 0 };
  var col = [];
  for (var i = 0; i < n2; i++) col.push([dv]);            // blank stays valid; off-list rejected
  fields.getRange(fStart + 1, cDep + 1, n2, 1).setDataValidations(col);
  return { stamped: n2 };
}

// --- Completeness (the sidebar data) ----------------------------------------

/** Per-cascade mapped/total + parent-empty + readiness. Reuses verifyLookupParents. */
function getTrack2Status(opts) {
  assertTrack1_();
  opts = opts || {};
  var ss = opts.ss || SpreadsheetApp.getActive();

  var v = verifyLookupParents({ ss: ss });               // {perLookup, badParentValues, ready}
  var childToParent = buildFieldCascadeMap_(ss).map;

  // parent value-set sizes (to flag "fill parent first")
  var sheet = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.table, H.value, H.parent]);
  var hm = headerMap_(values[hr]);
  var cTable = hm[H.table], cValue = hm[H.value];
  var sizes = {};
  for (var r = hr + 1; r < values.length; r++) {
    var ln = trim_(values[r][cTable]); if (!ln) continue;
    if (trim_(values[r][cValue])) sizes[ln] = (sizes[ln] || 0) + 1;
  }

  var rows = [];
  Object.keys(childToParent).sort().forEach(function (ln) {
    var pl = childToParent[ln];
    var s = v.perLookup[ln] || { total: 0, mapped: 0, unmapped: 0 };
    rows.push({
      lookup: ln, parent: pl,
      total: s.total, mapped: s.mapped, unmapped: s.unmapped,
      parentEmpty: !(sizes[pl] > 0)
    });
  });

  var ready = v.ready && rows.every(function (x) { return !x.parentEmpty; });
  return { rows: rows, ready: ready, badParentValues: v.badParentValues || [] };
}

// --- Sidebar ----------------------------------------------------------------

function showTrack2Sidebar() {
  assertTrack1_();
  var html = HtmlService.createHtmlOutput(track2SidebarHtml_())
    .setTitle('Cascade completeness')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

function track2SidebarHtml_() {
  return [
'<!DOCTYPE html><html><head><base target="_top"><style>',
'  body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#202124;margin:0;padding:12px;}',
'  h3{font-size:14px;margin:0 0 8px;font-weight:500;}',
'  .banner{padding:8px 10px;border-radius:6px;margin-bottom:12px;font-size:13px;}',
'  .ok{background:#e6f4ea;color:#137333;} .warn{background:#fef7e0;color:#b06000;}',
'  .row{border:1px solid #e0e0e0;border-radius:6px;padding:8px 10px;margin-bottom:8px;}',
'  .name{font-weight:500;} .sub{color:#5f6368;font-size:12px;margin-top:2px;}',
'  .bar{height:6px;background:#e8eaed;border-radius:3px;margin-top:6px;overflow:hidden;}',
'  .fill{height:6px;background:#1a73e8;} .fill.full{background:#137333;}',
'  .flag{color:#b06000;font-size:12px;margin-top:4px;} .bad{color:#c5221f;font-size:12px;margin-top:4px;}',
'  button{font-size:13px;padding:6px 10px;border:1px solid #dadce0;background:#fff;border-radius:6px;cursor:pointer;margin-right:6px;}',
'  button:hover{background:#f1f3f4;} .muted{color:#5f6368;font-size:12px;}',
'</style></head><body>',
'  <h3>Cascade completeness</h3>',
'  <div id="banner" class="banner muted">Loading…</div>',
'  <div id="list"></div>',
'  <div style="margin-top:10px;">',
'    <button onclick="refresh()">Refresh</button>',
'    <button onclick="restamp()">Re-stamp dropdowns</button>',
'  </div>',
'<script>',
'  function refresh(){ document.getElementById("banner").textContent="Loading…";',
'    google.script.run.withSuccessHandler(render).withFailureHandler(fail).getTrack2Status(); }',
'  function restamp(){ document.getElementById("banner").textContent="Stamping…";',
'    google.script.run.withSuccessHandler(refresh).withFailureHandler(fail).stampCascadeDropdowns(); }',
'  function fail(e){ document.getElementById("banner").className="banner warn";',
'    document.getElementById("banner").textContent=String(e&&e.message||e); }',
'  function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}',
'  function render(st){',
'    var b=document.getElementById("banner");',
'    if(st.ready){ b.className="banner ok"; b.textContent="Ready to provision — every cascade is complete."; }',
'    else { b.className="banner warn"; b.textContent="Not ready — some cascades are incomplete."; }',
'    var html="";',
'    st.rows.forEach(function(r){',
'      var pct = r.total ? Math.round(100*r.mapped/r.total) : 0;',
'      html += "<div class=\\"row\\"><div class=\\"name\\">"+esc(r.lookup)+"</div>";',
'      html += "<div class=\\"sub\\">cascades from "+esc(r.parent)+" \\u00b7 "+r.mapped+" / "+r.total+" mapped</div>";',
'      if(r.parentEmpty){ html += "<div class=\\"flag\\">fill the \\""+esc(r.parent)+"\\" list first</div>"; }',
'      else { html += "<div class=\\"bar\\"><div class=\\"fill"+(pct===100?" full":"")+"\\" style=\\"width:"+pct+"%\\"></div></div>"; }',
'      if(r.unmapped>0 && !r.parentEmpty){ html += "<div class=\\"flag\\">"+r.unmapped+" row(s) without a parent</div>"; }',
'      html += "</div>";',
'    });',
'    if(st.badParentValues && st.badParentValues.length){',
'      html += "<div class=\\"row\\"><div class=\\"name\\">Off-list parent values</div>";',
'      st.badParentValues.slice(0,8).forEach(function(x){',
'        html += "<div class=\\"bad\\">"+esc(x.lookup)+" row "+x.row+": \\""+esc(x.value)+"\\" not in "+esc(x.parent)+"</div>"; });',
'      html += "</div>";',
'    }',
'    document.getElementById("list").innerHTML = html || "<div class=\\"muted\\">No cascades declared.</div>";',
'  }',
'  refresh();',
'</script></body></html>'
  ].join('\n');
}

// --- Menu + installable triggers (coexist with sdc_lib) ---------------------

function sdcTrack2Menu() {
  SpreadsheetApp.getUi()
    .createMenu('SDC cascade')
    .addItem('Stamp dropdowns', 'stampCascadeDropdowns')
    .addItem('Show completeness', 'showTrack2Sidebar')
    .addToUi();
}

function sdcTrack2OnOpen(e) { sdcTrack2Menu(); }

function sdcTrack2OnEdit(e) {
  if (!e || !e.range) return;
  var name = e.range.getSheet().getName();
  if (name !== SDC_MIG.LOOKUPS_SHEET && name !== SDC_MIG.FIELDS_SHEET) return;
  // skip when the analyst is just picking a parent value (edit confined to that column)
  if (name === SDC_MIG.LOOKUPS_SHEET && isParentColumnEdit_(e)) return;
  stampCascadeDropdowns({ ss: e.source });
}

/** True if the edit is confined to the 5_lookups "Parent value" column. */
function isParentColumnEdit_(e) {
  try {
    var sheet = e.source.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
    var probe = sheet.getRange(1, 1, Math.min(12, sheet.getLastRow()), sheet.getLastColumn()).getValues();
    var hr = findHeaderRow_(probe, [SDC_MIG.HEADERS.table, SDC_MIG.HEADERS.value, SDC_MIG.HEADERS.parent]);
    if (hr === -1) return false;
    var cParent = headerMap_(probe[hr])[SDC_MIG.HEADERS.parent];   // 0-based
    var startCol = e.range.getColumn();
    var endCol = startCol + e.range.getNumColumns() - 1;
    return (startCol === cParent + 1 && endCol === cParent + 1);
  } catch (err) { return false; }
}

/** One-time setup. Idempotent — removes any prior Track 2 triggers first. */
function installSdcTrack2Triggers() {
  assertTrack1_();
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sdcTrack2OnOpen' || fn === 'sdcTrack2OnEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sdcTrack2OnOpen').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('sdcTrack2OnEdit').forSpreadsheet(ss).onEdit().create();
  SpreadsheetApp.getActive().toast('Track 2 triggers installed (onOpen + onEdit).', 'SDC cascade', 5);
}