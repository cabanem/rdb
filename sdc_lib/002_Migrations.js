/**
 * @file Migrations.gs (SDC library)
 * Workbook schema migration framework.
 *
 * For v1.0 this is structurally complete but functionally a no-op - there are no prior schema versions to migrate FROM. The plumbing is
 * here on purpose so v2.0 can add a real migration step without retrofitting the framework.
 *
 * How it works:
 *   - The chain is a list of {from, to, run} entries, ordered.
 *   - Migrations.run walks the chain from the workbook's current schema to SDC_SCHEMA_VERSION, applying each step in turn.
 *   - Each step's run(ss) function does the structural work (rename a sheet, add a column, rewrite a setting) and returns a summary.
 *   - On success, schema_version in _developer_settings is bumped.
 *   - On dryRun, the chain is reported but no changes are written.
 *
 * Container shim:
 *   onOpen detects a schema mismatch via Migrations.isMigrationNeeded(ss) and adds a "Migrate workbook schema" menu item that calls
 *   Migrations.run(ss). Workbooks self-detect the upgrade prompt; no manual coordination across N workbooks.
 *
 * Public:
 *   Migrations.run(ss, options)              -> Result   (canonical Result shape)
 *   Migrations.isMigrationNeeded(ss)         -> boolean
 *   Migrations.currentWorkbookVersion(ss)    -> string
 */

var Migrations = {};

// --- Migration chain -------------------------------------------------

/**
 * Ordered list of migration steps. Each step:
 *   - from:    schema version this step migrates FROM (e.g., '1.0')
 *   - to:      schema version this step migrates TO   (e.g., '1.1')
 *   - run(ss): performs the migration. Returns { changed: [...], notes: [...] }.
 *              Throws on unrecoverable failure.
 *
 * Empty for v1.0 - there is nothing to migrate from. Future entries land here in chronological order. Migrations.run walks them in order
 * to compose multi-step upgrades (e.g., 1.0 -> 1.1 -> 2.0).
 */
var MIGRATION_CHAIN = [
  // 1.0 ->> 1.1
  {
    from: '1.0',
    to: '1.1',
    run: function (ss) {
      return {
        changed: [],
        notes: ['Bridged pre-versioned workbook into the migration chain.']
      };
    }
  },
  // 1.1. ->> 1.2
  {
    from: '1.1',
    to: '1.2',
    run: function (ss) {
      // Additive, backward-compatible: a new supplier-read-only column in 4_fields. Absent/blank cells
      // read as false via Util.coerceTruthy, so existing workbooks are already correct without structural change.
      // This step only records the version bump.
      //
      // OPTIONAL: to surface the column header in existing workbooks, write the header text at
      // FIELDS_LAYOUT.SUPPLIER_READONLY_COL here. Skipped by default to avoid touching sheet structure
      // (and to avoid any chance of shifting column indices if positioned wrong).
      return {
        changed: [],
        notes: ['Supplier read-only flag available in 4_fields; existing ' +
          'fields default to editable.']
      };
    }
  },
  // 1.2 ->> 1.3
  {
    from: '1.2',
    to: '1.3',
    run: function (ss) {
      var changed = [];
      var notes = [];
      var sheet = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.3.');

      // --- 1. Label renames: old text -> new text, in place --------------
      // PLACEHOLDER: one entry per renamed label. Empty array = no renames.
      var RENAMES = [
        // { from: 'Old label text?', to: 'New label text?' }
      ];
      var data = sheet.getDataRange().getValues();
      RENAMES.forEach(function (r) {
        var oldNorm = r.from.toLowerCase().trim();   // mirror findValueRightOfLabel
        var newNorm = r.to.toLowerCase().trim();
        var found = false;
        for (var i = 0; i < data.length && !found; i++) {
          for (var j = 0; j < data[i].length && !found; j++) {
            var cell = String(data[i][j]).toLowerCase().trim();
            if (cell === oldNorm) {
              sheet.getRange(i + 1, j + 1).setValue(r.to);
              changed.push('Renamed label: "' + r.from + '" -> "' + r.to + '"');
              found = true;
            } else if (cell === newNorm) {
              found = true;  // already migrated - idempotent no-op
            }
          }
        }
        if (!found) notes.push('Label not found (old or new): "' + r.from +
          '". Verify 1_customer manually.');
      });

      // --- 2. Expected-date field: append label row if absent -------------
      var dateLabelNorm = Labels.expectedDate.toLowerCase().trim();
      var dateLabelPresent = data.some(function (row) {
        return row.some(function (c) {
          return String(c).toLowerCase().trim() === dateLabelNorm;
        });
      });
      if (!dateLabelPresent) {
        // Append BELOW existing content - never insert at/above row 6
        // (Variant._readVariantCount reads D6 positionally pre-1.3).
        var newRow = sheet.getLastRow() + 1;
        sheet.getRange(newRow, 2).setValue(Labels.expectedDate);   // label -> B
        // Guardrail on the value cell, matching the template.
        sheet.getRange(newRow, 4).setDataValidation(               // value  -> D
          SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
        );
        changed.push('Added field row "' + Labels.expectedDate + '" at row ' + newRow +
          ' with date validation on D' + newRow + '.');
        notes.push('Expected-date value is blank; the analyst must fill D' + newRow +
          ' before the next provision (preflight will name the field).');
      }

      // --- 3. 2_suppliers: "Has incumbent data?" column removal ----------
      // Notes-only: the connector's supplier parse is header-keyed and
      // tolerates both shapes; the parser/object-def changes ship in the
      // coordinated connector release.
      notes.push('2_suppliers "Has incumbent data?" is deprecated as of schema 1.3; ' +
        'the column may be removed from workbooks. Per-supplier seeding is ' +
        'derived downstream, not read from this column.');

      // --- 4. _mapping: removed from connector serialization --------------
      // Notes-only: CONNECTOR_SHEETS membership is library code, not workbook
      // structure. The sheet itself stays in workbooks untouched.
      // GATE: ships only with a clean dead-cargo verdict from the corpus trace.
      notes.push('_mapping is no longer serialized to config JSON as of schema 1.3 ' +
        '(volatile AR2 timestamp; confirmed unconsumed). The tab remains ' +
        'in the workbook.');

      return { changed: changed, notes: notes };
    }
  },
  // 1.3 ->> 1.4
  {
    from: '1.3',
    to: '1.4',
    run: function (ss) {
      var changed = [];
      var notes = [];
      var sheet = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.4.');

      // Historical label text as LITERALS — Labels no longer carries these
      // (Labels now holds only the new single-field wording). Migrations must
      // never read historical strings from the live Labels object.
      var OLD_R1 = 'From the initial request, how many days before we send the first reminder to each non-compliant supplier?';
      var OLD_R2 = 'Second reminder?';
      var OLD_R3 = 'Third reminder?';

      // --- 1. Merge the three reminder fields into one -------------------
      var newPresent = !!Util.findLabelCell(sheet, Labels.reminderDays);
      var r1 = Util.findLabelCell(sheet, OLD_R1);

      if (newPresent) {
        notes.push('Reminder cadence field already present; merge skipped (idempotent).');
      } else if (!r1) {
        notes.push('Old first-reminder label not found; reminder merge skipped. ' +
          'Verify 1_customer manually and add the "' + Labels.reminderDays +
          '" field by hand if needed.');
      } else {
        // Read historical values BEFORE any rewrite (tolerant 3-column scan,
        // since pre-1.4 layouts weren't declared).
        var v1 = Util.findValueRightOfLabel(sheet, OLD_R1);
        var v2 = Util.findValueRightOfLabel(sheet, OLD_R2);
        var v3 = Util.findValueRightOfLabel(sheet, OLD_R3);
        var merged = [v1, v2, v3]
          .filter(function (v) { return v !== null && v !== undefined && String(v).trim() !== ''; })
          .join(', ');

        // Locate the registry entry for the new field's declared value offset.
        var def = null;
        for (var i = 0; i < CUSTOMER_FIELDS.length; i++) {
          if (CUSTOMER_FIELDS[i].key === 'reminderDays') { def = CUSTOMER_FIELDS[i]; break; }
        }

        // Rewrite label in place; clear the row's old value area (up to 3
        // right) so a stale single number can't sit beside the merged list.
        sheet.getRange(r1.row, r1.col).setValue(Labels.reminderDays);
        sheet.getRange(r1.row, r1.col + 1, 1, 3).clearContent();

        // The old cells likely carry NUMERIC data validation, which would
        // reject the comma-separated string. Clear validation on the target
        // before writing.
        var target = sheet.getRange(r1.row, r1.col + def.valueOffset);
        target.clearDataValidations();
        target.setValue(merged);
        changed.push('Merged reminder days into one field ("' + merged + '") at row ' + r1.row + '.');

        // Clear the now-orphaned second and third reminder rows (label +
        // value area). Content-clear rather than row-delete: preserves any
        // template formatting/merges, and post-1.3 nothing reads 1_customer
        // positionally, so empty rows are harmless. Swap to deleteRow if you
        // prefer a tighter sheet.
        [OLD_R2, OLD_R3].forEach(function (lbl) {
          var c = Util.findLabelCell(sheet, lbl);
          if (c) {
            sheet.getRange(c.row, c.col, 1, 4).clearContent();
            changed.push('Cleared retired field "' + lbl + '" at row ' + c.row + '.');
          } else {
            notes.push('Retired label "' + lbl + '" not found; nothing to clear.');
          }
        });
      }

      // --- 2. Stamp named ranges for every registered field ---------------
      // From this point forward, question wording is presentation copy;
      // reads go through the named ranges.
      var nr = Customer.ensureNamedRanges(ss, DEFAULT_SHEETS.customer);
      if (nr.created.length > 0) {
        changed.push('Created named range(s): ' + nr.created.join(', ') + '.');
      }
      if (nr.unresolved.length > 0) {
        notes.push('Could not anchor named range(s) — label text not found: ' +
          nr.unresolved.map(function (u) { return u.rangeName + ' ("' + u.label + '")'; }).join('; ') +
          '. Restore the wording (or create the range manually), then re-run this ' +
          'migration or any provision/validate — both paths self-heal.');
      }

      // --- 3. Coordination notes ------------------------------------------
      notes.push('Payload contract bumps to 8.0 with this schema: reminder_days_1/2/3 ' +
        'replaced by reminder_days (int array). R-1 must handshake 8.0 before ' +
        'workbooks on this library provision.');
      notes.push('If any recipe parses reminder values from the serialized 1_customer ' +
        'GRID (config JSON) rather than the provision payload, that parse must ' +
        'change in the same coordinated release.');

      return { changed: changed, notes: notes };
    }
  },
  // 1.4 ->> 1.5
  {
    from: '1.4',
    to: '1.5',
    run: function (ss) {
      var changed = [];
      var notes = [];
      var sheet = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.5.');

      // Idempotency: presence of the LABEL is the test — findValueRightOfLabel
      // cannot distinguish "label absent" from "label present, value blank".
      if (Util.findLabelCell(sheet, Labels.lastDayForSubmission)) {
        notes.push('"' + Labels.lastDayForSubmission + '" already present; append skipped (idempotent).');
      } else {
        var newRow = sheet.getLastRow() + 1;   // append below content — never at/above positional reads
        sheet.getRange(newRow, 2).setValue(Labels.lastDayForSubmission);   // label -> B

        var target = sheet.getRange(newRow, 4);                            // value -> D (offset 2)
        target.clearDataValidations();
        target.setDataValidation(
          SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
        );

        changed.push('Added field row "' + Labels.lastDayForSubmission + '" at row ' + newRow +
          ' with date validation on D' + newRow + '.');
        notes.push('Last-day value is blank; the analyst must fill D' + newRow +
          ' before the next provision (preflight will name the field).');
      }

      // Anchor the named range now (mirrors the 1.3->1.4 step) so the read
      // contract doesn't depend on heal-on-read deriving the offset later.
      var nr = Customer.ensureNamedRanges(ss, DEFAULT_SHEETS.customer);
      if (nr.created.length > 0) changed.push('Created named range(s): ' + nr.created.join(', ') + '.');
      if (nr.unresolved.length > 0) notes.push('Could not anchor: ' + nr.unresolved.map(function (u) {
        return u.rangeName + ' ("' + u.label + '")';
      }).join('; '));

      return { changed: changed, notes: notes };
    }
  },

  // 1.5 ->> 1.6
  {
    from: '1.5',
    to: '1.6',
    run: function (ss) {
      var changed = [];
      var notes = [];
      var sheet = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.6.');

      var liveRange = function (name) {      // anchored AND readable, else null (a #REF! range throws on read)
        try { var r = ss.getRangeByName(name); if (r) { r.getValue(); return r; } } catch (e) { /* fall through */ }
        return null;
      };
      var colLetter = function (n) {
        var s = '';
        while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
        return s;
      };

      // --- 0. Layout: derived from an anchored range, never hardcoded ---------
      // v0.9.9 template: B = row number, C = label, D = value, E = required marker. The value column is read off
      // cfg_customer_name (required, anchored since 1.4); every other column is relative to it. Earlier migrations
      // assumed label->B / value->D, which the current template no longer matches.
      var anchor = liveRange('cfg_customer_name');
      if (!anchor) {
        var c = Util.findLabelCell(sheet, Labels.customerName);
        if (!c) {
          throw new Error('Cannot locate "' + Labels.customerName + '" (cfg_customer_name) on 1_customer; ' +
            'cannot infer the sheet layout for schema 1.6.');
        }
        anchor = sheet.getRange(c.row, c.col + 1);
      }
      var valueCol = anchor.getColumn();
      var labelCol = valueCol - 1;
      var numberCol = labelCol - 1;
      var markerCol = valueCol + 1;
      if (labelCol < 1) {
        throw new Error('1_customer layout unexpected: value column ' + valueCol + ' leaves no room for a label column.');
      }

      // --- 1. Re-stamp every anchored label to the current wording ------------
      // Wording is presentation copy; the named range is the contract. Writing Labels.* beside each anchored value
      // keeps the label fallback (and future migrations) working on every workbook, whatever text it was built with.
      CUSTOMER_FIELDS.forEach(function (def) {
        var r = liveRange(def.rangeName);
        if (!r) return;                                    // unanchored -> ensureNamedRanges below
        var cell = sheet.getRange(r.getRow(), labelCol);
        if (String(cell.getValue()).trim() !== def.label) {
          cell.setValue(def.label);
          changed.push('Re-stamped label at row ' + r.getRow() + ' to "' + def.label + '".');
        }
      });

      // --- 2. Append the two seed-row fields ------------------------------------
      // Idempotency: presence of the LABEL is the test. Rows go below existing content (never at/above positional
      // reads). The template owner may move them next to the other seed rows by hand; named ranges follow.
      // The required marker mirrors the seed-Drive-ID row: shown only while the incumbent flag is TRUE.
      var hasSeed = liveRange('cfg_has_seed_data');
      var markerFormula = null;
      if (hasSeed) {
        var ref = '$' + colLetter(hasSeed.getColumn()) + '$' + hasSeed.getRow();
        markerFormula = '=IF(ISBLANK(' + ref + '), "", IF(' + ref + '=TRUE, "*", ""))';
      }
      var defs = {};
      CUSTOMER_FIELDS.forEach(function (d) { defs[d.key] = d; });

      [defs.seedDataHeaderRow, defs.seedDataFirstDataRow].forEach(function (def) {
        if (Util.findLabelCell(sheet, def.label)) {
          notes.push('"' + def.label + '" already present; append skipped (idempotent).');
          return;
        }
        var newRow = sheet.getLastRow() + 1;
        if (numberCol >= 1) {
          var prevNo = Number(sheet.getRange(newRow - 1, numberCol).getValue());
          if (Number.isFinite(prevNo) && prevNo > 0) sheet.getRange(newRow, numberCol).setValue(prevNo + 1);
        }
        sheet.getRange(newRow, labelCol).setValue(def.label);

        var target = sheet.getRange(newRow, valueCol);
        target.clearDataValidations();
        target.setDataValidation(
          SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(1).setAllowInvalid(false).build()
        );
        if (markerFormula) sheet.getRange(newRow, markerCol).setFormula(markerFormula);

        changed.push('Added field row "' + def.label + '" at row ' + newRow +
          ' (blank = default; Preflight defaults header to 1 and first data row to header + 1).');
      });

      // --- 3. Anchor named ranges: the two new rows plus anything still unanchored ---
      var nr = Customer.ensureNamedRanges(ss, DEFAULT_SHEETS.customer);
      if (nr.created.length > 0) changed.push('Created named range(s): ' + nr.created.join(', ') + '.');
      if (nr.unresolved.length > 0) notes.push('Could not anchor: ' + nr.unresolved.map(function (u) {
        return u.rangeName + ' ("' + u.label + '")';
      }).join('; '));

      // --- 4. Coordination notes ------------------------------------------------
      notes.push('Payload contract bumps to 10.0 with this schema: seeded_data_header_row and ' +
        'seeded_data_first_data_row added to the provision payload. R-1 must accept 10.0 ' +
        'before workbooks on this library provision.');
      notes.push('Config JSON now carries a derived _customer block (typed, named-range read). The connector ' +
        'reads customer attributes from it in the coordinated release; the 1_customer grid parse is ' +
        'fallback only.');

      return { changed: changed, notes: notes };
    }
  },

  // 1.6 ->> 1.7
  {
    from: '1.6',
    to: '1.7',
    run: function (ss) {
      // Repairs what PrimaryKey.setupColumns (library <= 1.7.0) did under the unreconciled PRIMARY_KEY_COLUMNS table:
      //   6_variants             a stray _pk_variants_ column inserted at B, pushing "All fields" to C and the variant block
      //                          to H. Every fixed-index reader (Variant._extractIncludedFields, the connector's variant
      //                          parse) then read UUIDs as field names.
      //   4_complex_validations  a second PK column "_pk_rules" inserted at B beside the template's "_pk_rules_" (now C);
      //                          neither ever received a UUID.
      //   5_lookups              the entry declared header row 8 on a sheet whose header is row 5, so the note text
      //                          ("Primary key (UUID)", "Do not edit.", "_pk_lookup_table_") landed in the PK cells of
      //                          data rows 6-8 and the real header cell B5 stayed blank.
      //
      // Every step acts only on the exact fingerprint the old code left, so this is a no-op on a workbook that never ran
      // setupColumns, and idempotent on one that did. Row numbers are literals: this migration describes the 1.6
      // template as it was, not whatever the layout constants say later.
      //
      // Structure only. UUIDs for the rows this frees up are stamped by PrimaryKey.backfill on the next provision or
      // validate, as for any new row.
      var changed = [];
      var notes = [];
      var cell = function (sheet, row, col) {
        var v = sheet.getRange(row, col).getValue();
        return String(v === null || v === undefined ? '' : v).trim();
      };

      // --- 1. 6_variants: remove the stray PK column ----------------------------
      var vs = ss.getSheetByName(DEFAULT_SHEETS.variants);
      if (!vs) throw new Error('6_variants not found; cannot migrate schema to 1.7.');
      var vB5 = cell(vs, 5, 2);
      if (vB5 === '_pk_variants_') {
        if (cell(vs, 5, 3) !== 'All fields') {
          throw new Error('6_variants!B5 is "_pk_variants_" but C5 is "' + cell(vs, 5, 3) +
            '", not "All fields". The sheet is not in the shape this migration expects; inspect it by hand.');
        }
        vs.deleteColumn(2);
        changed.push('6_variants: removed the stray "_pk_variants_" column B. "All fields" is back at B, the first variant column at G.');
      } else if (vB5 === 'All fields') {
        notes.push('6_variants layout already correct; nothing to do.');
      } else {
        throw new Error('6_variants!B5 reads "' + vB5 + '"; expected "All fields" (or "_pk_variants_" to repair). Fix by hand, then re-run.');
      }

      // --- 2. 4_complex_validations: one PK column, named _pk_rules_ ------------
      var rs = ss.getSheetByName(DEFAULT_SHEETS.validations);
      if (!rs) throw new Error('4_complex_validations not found; cannot migrate schema to 1.7.');
      var rB10 = cell(rs, 10, 2), rC10 = cell(rs, 10, 3);
      if (rB10 === '_pk_rules' && rC10 === '_pk_rules_') {
        rs.deleteColumn(2);
        changed.push('4_complex_validations: removed the duplicate "_pk_rules" column B; the template\'s "_pk_rules_" is back at B.');
      } else if (rB10 === '_pk_rules' && rC10 === 'Target field') {
        // Workbook whose template had no PK column: the old code inserted one and named it without the trailing underscore.
        rs.getRange(10, 2).setValue('_pk_rules_');
        changed.push('4_complex_validations: renamed PK header B10 "_pk_rules" -> "_pk_rules_".');
      } else if (rB10 === '_pk_rules_') {
        notes.push('4_complex_validations PK column already correct; nothing to do.');
      } else {
        throw new Error('4_complex_validations!B10 reads "' + rB10 + '"; expected "_pk_rules_" (or "_pk_rules" to repair). Fix by hand, then re-run.');
      }

      // --- 3. 5_lookups: header at B5, note text out of the data rows -----------
      var ls = ss.getSheetByName(DEFAULT_SHEETS.lookups);
      if (!ls) throw new Error('5_lookups not found; cannot migrate schema to 1.7.');
      if (cell(ls, 5, 1) !== 'Table name') {
        throw new Error('5_lookups!A5 reads "' + cell(ls, 5, 1) + '"; expected "Table name". Fix by hand, then re-run.');
      }
      var lB5 = cell(ls, 5, 2);
      if (lB5 === '') {
        ls.getRange(5, 2).setValue('_pk_lookup_table_');
        changed.push('5_lookups: wrote the PK header "_pk_lookup_table_" at B5.');
      } else if (lB5 !== '_pk_lookup_table_') {
        throw new Error('5_lookups!B5 reads "' + lB5 + '"; expected blank or "_pk_lookup_table_". Fix by hand, then re-run.');
      }
      [['Primary key (UUID)', 6], ['Do not edit.', 7], ['_pk_lookup_table_', 8]].forEach(function (p) {
        if (cell(ls, p[1], 2) === p[0]) {
          ls.getRange(p[1], 2).clearContent();
          changed.push('5_lookups: cleared note text "' + p[0] + '" from B' + p[1] + ' (a data row).');
        }
      });

      if (changed.length) {
        notes.push('Rows freed above receive UUIDs on the next provision or validate (PrimaryKey.backfill).');
      }
      notes.push('Config JSON layout is unchanged from what the connector already parsed before the stray columns appeared; ' +
        'no payload or parser change is required for this schema.');

      return { changed: changed, notes: notes };
    }
  }
];

// --- Public API ------------------------------------------------------

/**
 * Run all applicable migrations to bring the workbook to SDC_SCHEMA_VERSION.
 *
 * Returns a canonical Result. Structured migration detail (fromVersion,
 * toVersion, applied steps, skipped steps) is carried on Result.data.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      [options]
 * @param {boolean}     [options.dryRun=false] - When true, report the chain
 *                                                that would run but make no changes.
 * @returns {Object} canonical Result
 */
Migrations.run = function (ss, options) {
  if (!ss) throw new Error('Migrations.run: ss is required.');
  var opts = options || {};
  var dryRun = Boolean(opts.dryRun);

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  var fromVersion, toVersion;
  try {
    fromVersion = Migrations.currentWorkbookVersion(ss);
    toVersion = SDC_SCHEMA_VERSION;
  } catch (e) {
    // Cannot read the workbook's version (e.g., _developer_settings missing).
    // Fail before any work and log the diagnostic.
    log('ERROR', 'Migration aborted: ' + e.message);
    return Result.fail({
      flow: 'migration',
      correlationId: correlationId,
      message: 'Migration aborted before starting: ' + e.message,
      error: {
        stage: 'version-lookup',
        message: e.message
      }
    });
  }

  log('INFO', (dryRun ? 'DRY RUN - ' : '') +
    'Starting migration: v' + fromVersion + ' -> v' + toVersion);

  var applied = [];
  var skipped = [];
  var path = Migrations._planPath(fromVersion, toVersion);

  if (path.length === 0) {
    var noPathMessage = fromVersion === toVersion
      ? 'Workbook is already at schema v' + toVersion + '. No migration needed.'
      : 'No migration path from v' + fromVersion + ' to v' + toVersion +
      '. Workbook may need manual remediation or a newer library version.';

    log('SUCCESS', noPathMessage);

    return Result.ok({
      flow: 'migration',
      correlationId: correlationId,
      message: noPathMessage,
      data: {
        fromVersion: fromVersion,
        toVersion: toVersion,
        applied: [],
        skipped: [],
        dryRun: dryRun
      }
    });
  }

  // Apply each step in order.
  for (var i = 0; i < path.length; i++) {
    var step = path[i];

    if (dryRun) {
      applied.push({
        from: step.from,
        to: step.to,
        changed: ['(dry run - not executed)'],
        notes: []
      });
      log('INFO', 'DRY RUN - would migrate v' + step.from + ' -> v' + step.to);
      continue;
    }

    try {
      var stepResult = step.run(ss);
      var changed = (stepResult && stepResult.changed) || [];
      var notes = (stepResult && stepResult.notes) || [];

      applied.push({ from: step.from, to: step.to, changed: changed, notes: notes });
      Migrations._stampSchemaVersion(ss, step.to);

      log('INFO', 'Migrated v' + step.from + ' -> v' + step.to + ': ' +
        (changed.length ? changed.join(', ') : 'no changes recorded'));
    } catch (e) {
      skipped.push({ from: step.from, to: step.to, reason: e.message });
      log('ERROR', 'Migration v' + step.from + ' -> v' + step.to + ' failed: ' + e.message);
      // Stop the chain on first failure - partial migration is worse
      // than no migration. The schema_version reflects whatever was
      // last successfully applied.
      break;
    }
  }

  var ok = skipped.length === 0;
  var finalVersion = ok ? toVersion : Migrations.currentWorkbookVersion(ss);
  var resultMessage = Migrations._buildMessage(fromVersion, toVersion, applied, skipped, dryRun);

  log(ok ? 'SUCCESS' : 'WARNING',
    'Migration finished. Applied: ' + applied.length + ', skipped: ' + skipped.length +
    '. Now at v' + finalVersion + '.');

  if (ok) {
    return Result.ok({
      flow: 'migration',
      correlationId: correlationId,
      message: resultMessage,
      data: {
        fromVersion: fromVersion,
        toVersion: finalVersion,
        applied: applied,
        skipped: [],
        dryRun: dryRun
      }
    });
  }

  return Result.fail({
    flow: 'migration',
    correlationId: correlationId,
    message: resultMessage,
    error: {
      stage: 'migration-step',
      message: skipped.length + ' migration step(s) failed. Workbook is at v' +
        finalVersion + '. See _script_logs for details.'
    }
  });
};

/**
 * Returns true when the workbook's declared schema version differs from
 * the library's expected major version. Cheap - used by onOpen to decide
 * whether to surface the migration menu item.
 */
Migrations.isMigrationNeeded = function (ss) {
  try {
    if (!ss) return false;
    var workbookVersion = Migrations.currentWorkbookVersion(ss);
    var wMajor = parseInt(String(workbookVersion).split('.')[0], 10);
    var lMajor = parseInt(String(SDC_SCHEMA_VERSION).split('.')[0], 10);
    return wMajor !== lMajor || workbookVersion !== SDC_SCHEMA_VERSION;
  } catch (e) {
    // If we can't read the version (e.g., _developer_settings missing),
    // don't surface the migration menu - the workbook has bigger problems
    // and Config.build will fail loudly with a clearer message.
    return false;
  }
};

/**
 * Read the workbook's declared schema version from _developer_settings.
 * Defaults to '1.0' when the meta.schema_version row is absent - this
 * matches Config.build's behavior so pre-v1.0 workbooks (which don't
 * declare a version) are treated as v1.0.
 */
Migrations.currentWorkbookVersion = function (ss) {
  if (!ss) throw new Error('Migrations.currentWorkbookVersion: ss is required.');

  var devSheet = ss.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("'_developer_settings' tab is missing from the workbook.");
  }

  var data = devSheet.getDataRange().getValues();
  var row = data.find(function (r) { return r[1] === 'meta' && r[2] === 'schema_version'; });
  return row ? String(row[3]) : '1.0';
};

// --- Private helpers -------------------------------------------------

/**
 * Walk the chain from `fromVersion` to `toVersion`, returning the ordered
 * subset of MIGRATION_CHAIN entries that compose the path. Returns []
 * if no path exists or none is needed.
 */
Migrations._planPath = function (fromVersion, toVersion) {
  if (fromVersion === toVersion) return [];

  var path = [];
  var current = fromVersion;

  // Up to MIGRATION_CHAIN.length hops - guards against malformed chains
  // creating infinite loops if from/to entries are misordered.
  for (var hop = 0; hop < MIGRATION_CHAIN.length + 1; hop++) {
    if (current === toVersion) return path;

    var next = MIGRATION_CHAIN.find(function (step) { return step.from === current; });
    if (!next) return [];

    path.push(next);
    current = next.to;
  }

  return [];
};

/**
 * Write the new schema_version into _developer_settings. Adds the row
 * if missing, updates it in place if present.
 */
Migrations._stampSchemaVersion = function (ss, version) {
  var devSheet = ss.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("Cannot stamp schema_version: '_developer_settings' is missing.");
  }

  var data = devSheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][1] === 'meta' && data[i][2] === 'schema_version') {
      devSheet.getRange(i + 1, 4).setValue(version);
      return;
    }
  }

  // Not found - append it. Column layout matches the existing developer
  // settings convention: A=description (optional), B=category, C=key, D=value.
  devSheet.appendRow(['', 'meta', 'schema_version', version]);
};

Migrations._buildMessage = function (fromVersion, toVersion, applied, skipped, dryRun) {
  var lines = [];
  lines.push((dryRun ? 'DRY RUN - ' : '') +
    'Schema migration: v' + fromVersion + ' -> v' + toVersion);

  if (applied.length > 0) {
    lines.push('');
    lines.push('Applied:');
    applied.forEach(function (a) {
      lines.push('  v' + a.from + ' -> v' + a.to);
      a.changed.forEach(function (c) { lines.push('    ->' + c); });
    });
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push('Skipped (chain stopped at first failure):');
    skipped.forEach(function (s) {
      lines.push('  v' + s.from + ' -> v' + s.to + ': ' + s.reason);
    });
  }

  if (applied.length === 0 && skipped.length === 0) {
    lines.push('');
    lines.push('No migration steps to apply.');
  }

  return lines.join('\n');
};
