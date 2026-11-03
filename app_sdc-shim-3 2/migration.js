/**
 * Track 1 — 5_lookups parent-value migration
 * SDC dropdown / cascade redesign
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 *   For every cascade child row in 5_lookups, it moves the parent reference out
 *   of the misused "Label" column into the "Parent value" column, normalised to
 *   the parent's own Value (e.g. "BE" -> "Belgium"), and clears the stray
 *   boolean (TRUE) that currently fills "Parent value" on every row.
 *
 *   End state per row:
 *     - cascade child, parent resolved : Parent value = parent's Value ; Label = ""
 *     - cascade child, parent NOT resolved : Parent value = ""        ; Label kept (a clue)
 *     - everything else (roots / flat lists): Parent value = ""        ; Label untouched
 *
 * HOW TO RUN
 *   1. Duplicate the whole workbook first (File > Make a copy). This is destructive.
 *   2. previewLookupMigration()  — dry run. Writes nothing. Read the log.
 *   3. applyLookupMigration()    — backs up the 5_lookups tab, then writes.
 *   4. verifyLookupParents()     — read-only check + per-lookup mapped counts.
 *
 * The result object is returned AND logged (View > Logs / Executions).
 */

var SDC_MIG = {
  LOOKUPS_SHEET: '5_lookups',
  FIELDS_SHEET:  '4_fields',
  HEADERS: {
    table:          'Table name',     // col A — lookup_name
    code:           'Column 7',       // the natural-key / code column (optional)
    value:          'Value',          // valid_value (the canonical spine)
    label:          'Label',          // currently misused to hold the parent key
    parent:         'Parent value',   // currently a stray boolean; target column
    fieldLookup:    'Lookup name',    // 4_fields: a field's own lookup
    fieldDependsOn: 'Depends on'      // 4_fields: the parent lookup
  },
  UNRESOLVED_EXAMPLES: 8
};

/** Dry run — writes nothing, just reports what it would do. */
function previewLookupMigration() {
  return migrateLookupParents({ dryRun: true });
}

/** Apply — backs up the 5_lookups tab, then migrates. */
function applyLookupMigration() {
  return migrateLookupParents({ dryRun: false });
}

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=true]  Default true. Pass false to write.
 * @param {Spreadsheet} [opts.ss]       Defaults to the active spreadsheet.
 * @returns {Object} structured report
 */
function migrateLookupParents(opts) {
  opts = opts || {};
  var dryRun = (opts.dryRun !== false);            // default: SAFE (dry run)
  var ss = opts.ss || SpreadsheetApp.getActive();

  // --- 1. cascade child-lookup -> parent-lookup, from 4_fields ---------------
  var cascade = buildFieldCascadeMap_(ss);
  var childToParent = cascade.map;

  // --- 2. read 5_lookups; locate header row BY NAME --------------------------
  var sheet = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  if (!sheet) throw new Error('Sheet not found: ' + SDC_MIG.LOOKUPS_SHEET);

  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.table, H.value, H.parent]);
  if (hr === -1) {
    throw new Error('Could not find the 5_lookups header row (need "' +
      H.table + '", "' + H.value + '", "' + H.parent + '").');
  }
  var hm = headerMap_(values[hr]);
  var cTable  = hm[H.table];
  var cValue  = hm[H.value];
  var cLabel  = hm[H.label];
  var cParent = hm[H.parent];
  var cCode   = hm[H.code];   // optional — undefined is fine
  [['Table name', cTable], ['Value', cValue], ['Label', cLabel], ['Parent value', cParent]]
    .forEach(function (p) {
      if (p[1] === undefined) throw new Error('Missing required 5_lookups column: "' + p[0] + '"');
    });

  var dataStart = hr + 1;                 // 0-based index of first data row
  var dataRows = values.length - dataStart;

  // --- 3. per-lookup value sets and alias maps (code OR value -> value) -------
  var aliasExact = {};   // lookup -> { aliasString : canonicalValue }
  var aliasCI = {};      // lookup -> { aliasLower  : canonicalValue }  (fallback)
  var valueSet = {};     // lookup -> { value : true }
  for (var r = dataStart; r < values.length; r++) {
    var ln = trim_(values[r][cTable]);
    if (!ln) continue;
    var val = trim_(values[r][cValue]);
    if (!val) continue;
    if (!aliasExact[ln]) { aliasExact[ln] = {}; aliasCI[ln] = {}; valueSet[ln] = {}; }
    valueSet[ln][val] = true;
    addAlias_(aliasExact[ln], aliasCI[ln], val, val);
    if (cCode !== undefined) {
      var code = trim_(values[r][cCode]);
      if (code) addAlias_(aliasExact[ln], aliasCI[ln], code, val);
    }
  }

  // --- 4. compute new Label and Parent value columns -------------------------
  var newLabelCol = [];
  var newParentCol = [];
  var report = {
    dryRun: dryRun,
    sheet: SDC_MIG.LOOKUPS_SHEET,
    headerRow: hr + 1,                 // 1-based, for humans
    cascadeLookups: Object.keys(childToParent).sort(),
    childToParent: childToParent,
    conflicts: cascade.conflicts,      // a lookup declared with two different parents
    perLookup: {},                     // ln -> { total, resolved, unresolved, caseNormalized, examples }
    parentCellsWritten: 0,             // Parent value cells whose value changed
    parentCellsCleared: 0,             // Parent value cells set to "" (stray boolean / unresolved)
    labelCellsCleared: 0,              // Label cells emptied (parent moved out)
    rowsScanned: 0
  };

  function stat_(ln) {
    if (!report.perLookup[ln]) {
      report.perLookup[ln] = { total: 0, resolved: 0, unresolved: 0, caseNormalized: 0, examples: [] };
    }
    return report.perLookup[ln];
  }

  for (var r = dataStart; r < values.length; r++) {
    var inLabel = values[r][cLabel];
    var inParent = values[r][cParent];
    var ln = trim_(values[r][cTable]);

    var outLabel = inLabel;
    var outParent = inParent;

    if (ln) {
      report.rowsScanned++;

      if (childToParent[ln]) {
        // ---- cascade child ----
        var pl = childToParent[ln];
        var s = stat_(ln);
        s.total++;

        // prefer an already-valid Parent value (idempotent re-runs), else Label
        var fromParent = (typeof inParent === 'string')
          ? resolveParent_(aliasExact, aliasCI, pl, inParent) : null;
        var fromLabel = resolveParent_(aliasExact, aliasCI, pl, inLabel);
        var res = fromParent || fromLabel;

        if (res) {
          outParent = res.value;       // the parent's Value (one vocabulary)
          outLabel = '';               // parent no longer lives in Label
          s.resolved++;
          if (res.ci) s.caseNormalized++;
        } else {
          outParent = '';              // drop the stray boolean; honest "needs parent"
          outLabel = inLabel;          // keep the raw clue for the analyst
          s.unresolved++;
          if (s.examples.length < SDC_MIG.UNRESOLVED_EXAMPLES) {
            s.examples.push({
              row: r + 1,
              value: trim_(values[r][cValue]),
              rawParent: trim_(inLabel)
            });
          }
        }
      } else {
        // ---- root / flat list: clear the stray boolean, leave Label alone ----
        outParent = '';
        outLabel = inLabel;
      }
    }

    if (!cellEqual_(inParent, outParent)) {
      if (trim_(outParent) === '') report.parentCellsCleared++;
      else report.parentCellsWritten++;
    }
    if (!cellEqual_(inLabel, outLabel)) report.labelCellsCleared++;

    newLabelCol.push([outLabel]);
    newParentCol.push([outParent]);
  }

  // --- 5. defensive verification: every written parent is a real parent value -
  report.integrityViolations = [];
  for (var i = 0; i < newParentCol.length; i++) {
    var v = trim_(newParentCol[i][0]);
    if (!v) continue;
    var ln2 = trim_(values[dataStart + i][cTable]);
    var pl2 = childToParent[ln2];
    if (pl2 && (!valueSet[pl2] || !valueSet[pl2][v])) {
      report.integrityViolations.push({ row: dataStart + i + 1, lookup: ln2, wrote: v, parent: pl2 });
    }
  }

  // --- 6. write (only when not a dry run) ------------------------------------
  if (!dryRun && dataRows > 0) {
    var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyyMMdd-HHmmss');
    sheet.copyTo(ss).setName(SDC_MIG.LOOKUPS_SHEET + '__bak_' + stamp);  // ignored by the connector
    sheet.getRange(dataStart + 1, cLabel + 1, dataRows, 1).setValues(newLabelCol);
    sheet.getRange(dataStart + 1, cParent + 1, dataRows, 1).setValues(newParentCol);
  }

  logReport_(report, ss, dryRun);
  return report;
}

/**
 * Read-only verifier. Recomputes the mapped/unmapped picture against the sheet
 * as it stands now (use after applying). This is also the seed for the Track 2
 * completeness counter.
 */
function verifyLookupParents(opts) {
  opts = opts || {};
  var ss = opts.ss || SpreadsheetApp.getActive();
  var cascade = buildFieldCascadeMap_(ss);
  var childToParent = cascade.map;

  var sheet = ss.getSheetByName(SDC_MIG.LOOKUPS_SHEET);
  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.table, H.value, H.parent]);
  var hm = headerMap_(values[hr]);
  var cTable = hm[H.table], cValue = hm[H.value], cParent = hm[H.parent];

  var valueSet = {};
  for (var r = hr + 1; r < values.length; r++) {
    var ln = trim_(values[r][cTable]); if (!ln) continue;
    var v = trim_(values[r][cValue]); if (!v) continue;
    (valueSet[ln] || (valueSet[ln] = {}))[v] = true;
  }

  var out = { perLookup: {}, badParentValues: [], ready: true };
  for (var r2 = hr + 1; r2 < values.length; r2++) {
    var ln2 = trim_(values[r2][cTable]); if (!ln2) continue;
    if (!childToParent[ln2]) continue;
    var pl = childToParent[ln2];
    var s = out.perLookup[ln2] || (out.perLookup[ln2] = { total: 0, mapped: 0, unmapped: 0 });
    s.total++;
    var pv = trim_(values[r2][cParent]);
    if (!pv) { s.unmapped++; out.ready = false; continue; }
    if (!valueSet[pl] || !valueSet[pl][pv]) {
      out.badParentValues.push({ row: r2 + 1, lookup: ln2, value: pv, parent: pl });
      out.ready = false;
    } else {
      s.mapped++;
    }
  }
  Logger.log('verifyLookupParents: ' + JSON.stringify(out, null, 2));
  return out;
}

// --- helpers ----------------------------------------------------------------

/** child-lookup -> parent-lookup, derived from 4_fields "Lookup name"/"Depends on". */
function buildFieldCascadeMap_(ss) {
  var sheet = ss.getSheetByName(SDC_MIG.FIELDS_SHEET);
  if (!sheet) throw new Error('Sheet not found: ' + SDC_MIG.FIELDS_SHEET);
  var values = sheet.getDataRange().getValues();
  var H = SDC_MIG.HEADERS;
  var hr = findHeaderRow_(values, [H.fieldLookup, H.fieldDependsOn]);
  if (hr === -1) {
    throw new Error('Could not find the 4_fields header row (need "' +
      H.fieldLookup + '" and "' + H.fieldDependsOn + '").');
  }
  var hm = headerMap_(values[hr]);
  var cChild = hm[H.fieldLookup];
  var cParent = hm[H.fieldDependsOn];
  var map = {}, conflicts = [];
  for (var r = hr + 1; r < values.length; r++) {
    var child = trim_(values[r][cChild]);
    var parent = trim_(values[r][cParent]);
    if (!child || !parent) continue;
    if (map[child] && map[child] !== parent) {
      conflicts.push({ lookup: child, declaredParent: map[child], alsoDeclared: parent });
    } else {
      map[child] = parent;
    }
  }
  return { map: map, conflicts: conflicts };
}

/** First row index (0-based) whose cells contain every required header string. */
function findHeaderRow_(values, required) {
  for (var r = 0; r < values.length; r++) {
    var row = values[r].map(function (c) { return trim_(c); });
    var ok = required.every(function (h) { return row.indexOf(h) !== -1; });
    if (ok) return r;
  }
  return -1;
}

/** header string -> 0-based column index (first occurrence wins). */
function headerMap_(headerRow) {
  var m = {};
  headerRow.forEach(function (c, i) {
    var k = trim_(c);
    if (k && !(k in m)) m[k] = i;
  });
  return m;
}

function addAlias_(exact, ci, key, value) {
  if (!(key in exact)) exact[key] = value;
  var lk = key.toLowerCase();
  if (!(lk in ci)) ci[lk] = value;
}

/** Resolve a raw parent reference to the parent's canonical Value, or null. */
function resolveParent_(aliasExact, aliasCI, parentLookup, raw) {
  var key = trim_(raw);
  if (!key) return null;
  var ex = aliasExact[parentLookup];
  if (!ex) return null;                       // parent lookup unknown
  if (key in ex) return { value: ex[key], ci: false };
  var lk = key.toLowerCase();
  if (aliasCI[parentLookup] && (lk in aliasCI[parentLookup])) {
    return { value: aliasCI[parentLookup][lk], ci: true };
  }
  return null;
}

function trim_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function cellEqual_(a, b) {
  return trim_(a) === trim_(b);
}

function logReport_(report, ss, dryRun) {
  var lines = [];
  lines.push((dryRun ? '[DRY RUN] ' : '[APPLIED] ') + 'Track 1 lookup-parent migration');
  lines.push('cascade lookups: ' + report.cascadeLookups.join(', '));
  if (report.conflicts.length) {
    lines.push('CONFLICTS (a lookup with two declared parents): ' + JSON.stringify(report.conflicts));
  }
  Object.keys(report.perLookup).sort().forEach(function (ln) {
    var s = report.perLookup[ln];
    var line = '  ' + ln + ': ' + s.resolved + '/' + s.total + ' resolved';
    if (s.unresolved) line += ', ' + s.unresolved + ' UNRESOLVED';
    if (s.caseNormalized) line += ', ' + s.caseNormalized + ' case-normalised';
    lines.push(line);
    if (s.unresolved) {
      s.examples.forEach(function (e) {
        lines.push('      row ' + e.row + ': value="' + e.value + '" rawParent="' + e.rawParent + '"');
      });
    }
  });
  lines.push('writes: parent set=' + report.parentCellsWritten +
    ', parent cleared=' + report.parentCellsCleared +
    ', label cleared=' + report.labelCellsCleared +
    ' (rows scanned=' + report.rowsScanned + ')');
  if (report.integrityViolations.length) {
    lines.push('INTEGRITY VIOLATIONS: ' + JSON.stringify(report.integrityViolations));
  }
  var msg = lines.join('\n');
  Logger.log(msg);
  try { ss.toast((dryRun ? 'Dry run complete — see logs' : 'Migration applied — see logs'), 'Track 1', 5); } catch (e) {}
}