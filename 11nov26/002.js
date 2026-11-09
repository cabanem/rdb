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
 *   Migrations.repairLayout(ss)              -> Result   (canonical Result shape; version-independent, see below)
 *   Migrations.isMigrationNeeded(ss)         -> boolean
 *   Migrations.currentWorkbookVersion(ss)    -> string
 *
 * Repair vs migrate:
 *   A migration step runs once, when the chain walks past it. The structural repairs it performs (removing a stray
 *   column, say) are also needed by a workbook whose schema_version already reads current but whose sheets were
 *   copied from, or edited into, the old shape: the chain will never visit that workbook again, so "run Migrate" is
 *   a dead end for it. Migrations.repairLayout applies the same fingerprint-gated, idempotent repairs regardless of
 *   the stamped version, then re-runs Layout.verify and reports what is still wrong. Preflight points at it when
 *   Layout.verify fails on an already-current workbook.
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

      // Historical label as a LITERAL: the field was retired in schema 1.10 and Labels no longer carries it.
      // A workbook passing through here still gets the row (the 1.9 -> 1.10 step deletes it again), so the
      // chain stays faithful to what each schema looked like.
      var LAST_DAY_LABEL_1_5 = 'Last day for data submission';

      // Idempotency: presence of the LABEL is the test — findValueRightOfLabel
      // cannot distinguish "label absent" from "label present, value blank".
      if (Util.findLabelCell(sheet, LAST_DAY_LABEL_1_5)) {
        notes.push('"' + LAST_DAY_LABEL_1_5 + '" already present; append skipped (idempotent).');
      } else {
        var newRow = sheet.getLastRow() + 1;   // append below content — never at/above positional reads
        sheet.getRange(newRow, 2).setValue(LAST_DAY_LABEL_1_5);   // label -> B

        var target = sheet.getRange(newRow, 4);                            // value -> D (offset 2)
        target.clearDataValidations();
        target.setDataValidation(
          SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
        );

        changed.push('Added field row "' + LAST_DAY_LABEL_1_5 + '" at row ' + newRow +
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

      // --- 2. Seed-row fields ---------------------------------------------------
      // 1.6 appended "Seed data header row" and "Seed data first data row" here. Both were retired in 1.9 together
      // with the rest of the seed-data block, so a workbook passing through this step no longer gets rows that the
      // 1.8 -> 1.9 step would delete again. The keys are gone from CUSTOMER_FIELDS; nothing here may reference them.
      notes.push('Seed header / first-data-row fields are not added: retired in schema 1.9.');

      // --- 3. Anchor named ranges: anything still unanchored ---------------------
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
      // --- 2. 4_complex_validations: one PK column, named _pk_rules_ ------------
      // Both repairs are shared with Migrations.repairLayout (same fingerprints, same literals); see the helpers below.
      [Migrations._repairVariantsStrayPk(ss), Migrations._repairRulesDuplicatePk(ss)].forEach(function (r) {
        Array.prototype.push.apply(changed, r.changed);
        Array.prototype.push.apply(notes, r.notes);
      });

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
  },

  // 1.7 ->> 1.8
  {
    from: '1.7',
    to: '1.8',
    run: function (ss) {
      // Routing. The workbook stops carrying one URL per endpoint and carries the router instead. Adds the three
      // rows the 1.9.0 library reads (blank when the workbook has not been claimed yet; the routing workbook fills
      // them on claim) and seeds router.apiToken from the old webhook.apiPlatformToken when that is still the same
      // API client. Nothing is deleted: the old webhook.* rows are inert and useful for a rollback.
      var changed = [];
      var notes = [];
      var devSheet = ss.getSheetByName('_developer_settings');
      if (!devSheet) throw new Error("'_developer_settings' is missing; cannot migrate schema to 1.8.");

      var data = devSheet.getDataRange().getValues();
      var find = function (category, key) {
        for (var i = 0; i < data.length; i++) {
          if (data[i][1] === category && data[i][2] === key) return { row: i + 1, value: data[i][3] };
        }
        return null;
      };
      var ensure = function (category, key, value, description) {
        var hit = find(category, key);
        if (hit) { notes.push(category + '.' + key + ' already present; left as is.'); return; }
        var desc = description === undefined ? '' : description;
        devSheet.appendRow(['', category, key, value, desc]);
        data.push(['', category, key, value, desc]);
        changed.push('_developer_settings: added ' + category + '.' + key + (value ? ' (seeded)' : ' (blank)') + '.');
      };

      // Seed router.apiToken from the old per-workspace token when the workbook still carries one. Blank otherwise;
      // the routing workbook writes the real value on claim.
      var oldToken = find('webhook', 'apiPlatformToken');
      var seedToken = oldToken ? String(oldToken.value === null || oldToken.value === undefined ? '' : oldToken.value).trim() : '';

      ensure('router', 'baseUrl', '', 'SDC router collection base URL (…/router-v1). Written on claim.');
      ensure('router', 'apiToken', seedToken, 'SDC router API token. Written on claim.');
      ensure('meta', 'workspace_key', '', 'Client workspace this workbook is bound to. Traceability only; written on claim.');

      notes.push(seedToken
        ? 'router.apiToken seeded from webhook.apiPlatformToken. Replace it if the router uses a different API client.'
        : 'No webhook.apiPlatformToken to seed from; router.apiToken is blank until the workbook is claimed.');
      notes.push('The webhook.*Url rows are no longer read by the library; every call now goes through router.baseUrl + /route.');
      return { changed: changed, notes: notes };
    }
  },

  // 1.8 ->> 1.9
  {
    from: '1.8',
    to: '1.9',
    run: function (ss) {
      // Incumbent (seed) data and supplier messaging leave the workbook. Each retired field is located by its named
      // range first (the 1.4+ read contract) and by its label text second; the row is deleted, the named range
      // dropped, and column B renumbered. Retired wording is kept HERE, not in Labels, per the Schema.gs rule.
      // Idempotent: a field already gone is noted and skipped.
      var changed = [];
      var notes = [];
      var sheet = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.9.');

      var RETIRED = [
        { rangeName: 'cfg_supplier_instructions',    label: 'Portal instructions' },
        { rangeName: 'cfg_kickoff_email_body',       label: 'Kick off email instructions' },
        { rangeName: 'cfg_has_seed_data',            label: 'Incumbent data flag' },
        { rangeName: 'cfg_seed_data_drive_id',       label: 'Seed data Drive file ID' },
        { rangeName: 'cfg_seed_data_sheet_name',     label: 'Seed data sheet name' },
        { rangeName: 'cfg_seed_data_index_key',      label: 'Seed data index key' },
        { rangeName: 'cfg_seed_data_header_row',     label: 'Seed data header row' },
        { rangeName: 'cfg_seed_data_first_data_row', label: 'Seed data first data row' }
      ];

      var liveRange = function (name) {
        try { var r = ss.getRangeByName(name); if (r) { r.getValue(); return r; } } catch (e) { /* fall through */ }
        return null;
      };
      var dropRange = function (name) {
        try { ss.removeNamedRange(name); return true; } catch (e) { return false; }
      };

      // --- 0. Layout from the anchored customer-name range (as 1.6 does) ---------
      var anchor = liveRange('cfg_customer_name');
      if (!anchor) {
        var c = Util.findLabelCell(sheet, Labels.customerName);
        if (!c) {
          throw new Error('Cannot locate "' + Labels.customerName + '" (cfg_customer_name) on 1_customer; ' +
            'cannot infer the sheet layout for schema 1.9.');
        }
        anchor = sheet.getRange(c.row, c.col + 1);
      }
      var numberCol = anchor.getColumn() - 2;            // B = row number, C = label, D = value

      // --- 1. Locate every retired row before deleting any (row numbers shift on delete) ---
      var rows = [];
      RETIRED.forEach(function (f) {
        var r = liveRange(f.rangeName), row = null;
        if (r) row = r.getRow();
        else { var hit = Util.findLabelCell(sheet, f.label); if (hit) row = hit.row; }
        if (row === null) { notes.push('"' + f.label + '" (' + f.rangeName + ') not present; nothing to remove.'); }
        else rows.push({ row: row, field: f });
        if (dropRange(f.rangeName)) changed.push('Removed named range ' + f.rangeName + '.');
      });

      // --- 2. Delete bottom-up so earlier row numbers stay valid ------------------
      rows.sort(function (a, b) { return b.row - a.row; }).forEach(function (x) {
        sheet.deleteRow(x.row);
        changed.push('Deleted row ' + x.row + ' ("' + x.field.label + '").');
      });

      // --- 3. Renumber column B: every numbered row, in order, from 1 -------------
      if (rows.length && numberCol >= 1) {
        var last = sheet.getLastRow();
        var nums = sheet.getRange(1, numberCol, last, 1).getValues();
        var n = 0, out = [];
        for (var i = 0; i < nums.length; i++) {
          var v = Number(nums[i][0]);
          out.push([Number.isFinite(v) && v > 0 && String(nums[i][0]).trim() !== '' ? ++n : nums[i][0]]);
        }
        sheet.getRange(1, numberCol, last, 1).setValues(out);
        changed.push('Renumbered column ' + String.fromCharCode(64 + numberCol) + ' (1..' + n + ').');
      }

      // --- 4. Coordination notes ----------------------------------------------------
      notes.push('Payload contract bumps to 11.0 with this schema: supplier_instructions, kick_off_email_body and the ' +
        'seeded_data_* / has_seeded_data fields are no longer sent. The workspace endpoints must accept 11.0 before ' +
        'workbooks on this library provision.');
      return { changed: changed, notes: notes };
    }
  },

  // 1.9 ->> 1.10
  {
    from: '1.9',
    to: '1.10',
    run: function (ss) {
      // 1_customer converges on the seven implementation attributes. Three rows leave ("Application name",
      // "Drive folder ID", "Last day for data submission") and one arrives ("Customer logo public link", anchored as
      // cfg_customer_logo_url directly below the last remaining field). Same mechanics as 1.8 -> 1.9: locate by named
      // range, label text as fallback, delete bottom-up, drop the ranges, renumber column B. Retired wording lives
      // HERE, not in Labels. Idempotent: rows already gone / already present are noted and skipped.
      var changed = [];
      var notes = [];
      var sheet = ss.getSheetByName(DEFAULT_SHEETS.customer);
      if (!sheet) throw new Error('1_customer not found; cannot migrate schema to 1.10.');

      var RETIRED = [
        { rangeName: 'cfg_application_name',        label: 'Application name' },
        { rangeName: 'cfg_output_folder_id',        label: 'Drive folder ID' },
        { rangeName: 'cfg_last_day_for_submission', label: 'Last day for data submission' }
      ];
      var logoDef = null;
      for (var d = 0; d < CUSTOMER_FIELDS.length; d++) {
        if (CUSTOMER_FIELDS[d].key === 'customerLogoUrl') { logoDef = CUSTOMER_FIELDS[d]; break; }
      }
      if (!logoDef) throw new Error('CUSTOMER_FIELDS has no customerLogoUrl entry; Schema.gs and this migration are out of sync.');

      var liveRange = function (name) {
        try { var r = ss.getRangeByName(name); if (r) { r.getValue(); return r; } } catch (e) { /* fall through */ }
        return null;
      };
      var dropRange = function (name) {
        try { ss.removeNamedRange(name); return true; } catch (e) { return false; }
      };
      var colLetter = function (n) {
        var s = '';
        while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
        return s;
      };

      // --- 0. Layout from the anchored customer-name range (as 1.6 and 1.9 do) ----------
      var anchor = liveRange('cfg_customer_name');
      if (!anchor) {
        var c = Util.findLabelCell(sheet, Labels.customerName);
        if (!c) {
          throw new Error('Cannot locate "' + Labels.customerName + '" (cfg_customer_name) on 1_customer; ' +
            'cannot infer the sheet layout for schema 1.10.');
        }
        anchor = sheet.getRange(c.row, c.col + 1);
      }
      var valueCol = anchor.getColumn();                 // B = row number, C = label, D = value, E = required marker
      var labelCol = valueCol - 1;
      var numberCol = valueCol - 2;

      // --- 1. Locate every retired row before deleting any (row numbers shift on delete) ---
      var rows = [];
      RETIRED.forEach(function (f) {
        var r = liveRange(f.rangeName), row = null;
        if (r) row = r.getRow();
        else { var hit = Util.findLabelCell(sheet, f.label); if (hit) row = hit.row; }
        if (row === null) { notes.push('"' + f.label + '" (' + f.rangeName + ') not present; nothing to remove.'); }
        else rows.push({ row: row, field: f });
        if (dropRange(f.rangeName)) changed.push('Removed named range ' + f.rangeName + '.');
      });

      // --- 2. Delete bottom-up so earlier row numbers stay valid ------------------
      rows.sort(function (a, b) { return b.row - a.row; }).forEach(function (x) {
        sheet.deleteRow(x.row);
        changed.push('Deleted row ' + x.row + ' ("' + x.field.label + '").');
      });

      // --- 3. Add the logo row directly below the last remaining field ---------------
      //     "Last remaining field" = the lowest row any live cfg_* range sits on, read AFTER the deletes so the
      //     positions are current. Inserting (not appending at getLastRow) keeps the field inside the block even
      //     when the template carries notes below it.
      var addedLogo = false;
      if (liveRange(logoDef.rangeName) || Util.findLabelCell(sheet, logoDef.label)) {
        notes.push('"' + logoDef.label + '" already present; add skipped (idempotent).');
      } else {
        var lastFieldRow = 0;
        CUSTOMER_FIELDS.forEach(function (def) {
          var r = liveRange(def.rangeName);
          if (r && r.getRow() > lastFieldRow) lastFieldRow = r.getRow();
        });
        if (lastFieldRow === 0) lastFieldRow = anchor.getRow();

        sheet.insertRowAfter(lastFieldRow);                  // inherits the field block's formatting
        var newRow = lastFieldRow + 1;
        sheet.getRange(newRow, labelCol).setValue(logoDef.label);
        var valueCell = sheet.getRange(newRow, valueCol);
        valueCell.clearDataValidations();
        valueCell.clearContent();
        ss.setNamedRange(logoDef.rangeName, valueCell);
        if (numberCol >= 1) {
          // Provisional number (previous field + 1) so the renumber pass below treats the row as a field row.
          var prev = Number(sheet.getRange(lastFieldRow, numberCol).getValue());
          sheet.getRange(newRow, numberCol).setValue(Number.isFinite(prev) && prev > 0 ? prev + 1 : 1);
        }
        addedLogo = true;
        changed.push('Added field row "' + logoDef.label + '" at row ' + newRow + ' (named range ' +
          logoDef.rangeName + ' on ' + colLetter(valueCol) + newRow + ').');
        notes.push('"' + logoDef.label + '" is optional and blank; when set it must be an http(s) URL that resolves ' +
          'to the image itself (preflight checks the shape, not the reachability).');
      }

      // --- 4. Renumber column B: every numbered row, in order, from 1 -------------
      if ((rows.length || addedLogo) && numberCol >= 1) {
        var last = sheet.getLastRow();
        var nums = sheet.getRange(1, numberCol, last, 1).getValues();
        var n = 0, out = [];
        for (var i = 0; i < nums.length; i++) {
          var v = Number(nums[i][0]);
          out.push([Number.isFinite(v) && v > 0 && String(nums[i][0]).trim() !== '' ? ++n : nums[i][0]]);
        }
        sheet.getRange(1, numberCol, last, 1).setValues(out);
        changed.push('Renumbered column ' + colLetter(numberCol) + ' (1..' + n + ').');
      }

      // --- 5. Anchor anything still unanchored (belt and braces; idempotent) ---------
      var nr = Customer.ensureNamedRanges(ss, DEFAULT_SHEETS.customer);
      if (nr.created.length > 0) changed.push('Created named range(s): ' + nr.created.join(', ') + '.');
      if (nr.unresolved.length > 0) notes.push('Could not anchor: ' + nr.unresolved.map(function (u) {
        return u.rangeName + ' ("' + u.label + '")';
      }).join('; '));

      // --- 5b. Dropdowns for the pick-list fields (Target VMS, Variant count) ------------
      //      Registry-driven and idempotent, so a workbook whose analyst cleared a validation gets it back on re-run.
      var dv = Customer.ensureValidations(ss, DEFAULT_SHEETS.customer);
      if (dv.applied.length > 0) changed.push('Stamped dropdown(s): ' + dv.applied.join(', ') + '.');
      if (dv.unresolved.length > 0) notes.push('Could not place dropdown(s): ' + dv.unresolved.map(function (u) {
        return u.rangeName + ' ("' + u.label + '")';
      }).join('; '));
      notes.push('Every 1_customer field is required at provision from schema 1.10 (Target VMS, Variant count and the ' +
        'logo link included). Preflight names any blank one.');

      // --- 6. Coordination notes ----------------------------------------------------
      notes.push('Payload contract bumps to 12.0 with this schema: application_name, output_drive_folder_id and ' +
        'last_day_for_submission are no longer sent; customer_logo_url (string, may be empty) is added. The ' +
        'workspace endpoints (API-00 trigger schema, Functional core customer_required_attributes) must accept 12.0 ' +
        'before workbooks on this library provision.');
      return { changed: changed, notes: notes };
    }
  },

  // 1.10 ->> 1.11
  {
    from: '1.10',
    to: '1.11',
    run: function (ss) {
      // 5_lookups loses its primary-key column. The column was mis-modelled from the start: "_pk_lookup_table_" named a
      // per-table entity, but backfill stamped one UUID per ROW (keyColIndex pointed at Table name), and nothing read
      // the result. The Functional core connector's parse_lookups_sheet reads Table name / Value / Label / Parent value /
      // Record active? / Project specific? by header text and never a _pk_ column; validate_config keys lookup rows on
      // (lookup_name, valid_value, parent_value). Packs._mergeLookups re-minted every id on each apply, so the
      // "stable across re-publishes" property never held for this sheet either.
      //
      // After this step 5_lookups reads: Table name | Code | Value | Label | Parent value | Record active? | Project specific?
      // from column A, header row 5, data from row 6. The `lookups` named range and the _mapping filter on this sheet
      // adjust themselves when the column is deleted. The connector's default_sheet_config.lookups (header 4 / data 5,
      // 0-indexed) is unchanged. Payload stays 12.0.
      //
      // Idempotent: a workbook already in the target shape is noted and left alone.
      var r = Migrations._repairLookupsPk(ss);
      r.notes.push('PRIMARY_KEY_COLUMNS no longer lists 5_lookups; Layout.verify stops checking for a PK header there.');
      r.notes.push('Open contract decision: the "Code" column is written by packs but not read by the connector. Either read it ' +
        '(lookup_definition.code; natural key becomes Table name + Code) or retire it from PACK_LOOKUP_HEADERS.');
      return { changed: r.changed, notes: r.notes };
    }
  }
];

// --- Structural repairs (shared by migration steps and Migrations.repairLayout) ------------------------------------
/**
 * Each repair acts only on the exact fingerprint the old code left, is a no-op on a workbook already in shape, and
 * throws (with the offending cell quoted) on anything else, so a hand-edited sheet is never "repaired" into a third
 * shape. Row and column numbers are literals: these describe the template as it was, not the layout constants.
 * Each returns { changed: string[], notes: string[] }.
 */
Migrations._cellText = function (sheet, row, col) {
  var v = sheet.getRange(row, col).getValue();
  return String(v === null || v === undefined ? '' : v).trim();
};

/** 6_variants: library <= 1.7.0 inserted a "_pk_variants_" column at B, pushing "All fields" to C and the variant block to H. */
Migrations._repairVariantsStrayPk = function (ss) {
  var changed = [], notes = [];
  var vs = ss.getSheetByName(DEFAULT_SHEETS.variants);
  if (!vs) throw new Error('6_variants not found; cannot repair its layout.');
  var vB5 = Migrations._cellText(vs, 5, 2);
  if (vB5 === '_pk_variants_') {
    if (Migrations._cellText(vs, 5, 3) !== 'All fields') {
      throw new Error('6_variants!B5 is "_pk_variants_" but C5 is "' + Migrations._cellText(vs, 5, 3) +
        '", not "All fields". The sheet is not in the shape this repair expects; inspect it by hand.');
    }
    vs.deleteColumn(2);
    changed.push('6_variants: removed the stray "_pk_variants_" column B. "All fields" is back at B, the first variant column at G.');
  } else if (vB5 === 'All fields') {
    notes.push('6_variants layout already correct; nothing to do.');
  } else {
    throw new Error('6_variants!B5 reads "' + vB5 + '"; expected "All fields" (or "_pk_variants_" to repair). Fix by hand, then re-run.');
  }
  return { changed: changed, notes: notes };
};

/** 4_complex_validations: library <= 1.7.0 inserted a second PK column "_pk_rules" at B beside the template's "_pk_rules_". */
Migrations._repairRulesDuplicatePk = function (ss) {
  var changed = [], notes = [];
  var rs = ss.getSheetByName(DEFAULT_SHEETS.validations);
  if (!rs) throw new Error('4_complex_validations not found; cannot repair its layout.');
  var rB10 = Migrations._cellText(rs, 10, 2), rC10 = Migrations._cellText(rs, 10, 3);
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
  return { changed: changed, notes: notes };
};

/**
 * 5_lookups (schema 1.11): no PK column. Removes column B when it is the retired PK column, in either of the two
 * shapes it ever had: headed "_pk_lookup_table_" (schema 1.7 - 1.10), or blank-headed with nothing but UUIDs or
 * blanks beneath (the v0.9.9 template's reserved column that setupColumns never claimed). Any other content in B
 * is data and is left alone with an error, never deleted.
 */
Migrations._repairLookupsPk = function (ss) {
  var changed = [], notes = [];
  var UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ls = ss.getSheetByName(DEFAULT_SHEETS.lookups);
  if (!ls) throw new Error('5_lookups not found; cannot repair its layout.');
  if (Migrations._cellText(ls, 5, 1) !== 'Table name') {
    throw new Error('5_lookups!A5 reads "' + Migrations._cellText(ls, 5, 1) + '"; expected "Table name". Fix by hand, then re-run.');
  }
  var lB5 = Migrations._cellText(ls, 5, 2);
  var removable = false;
  if (lB5 === '_pk_lookup_table_') {
    removable = true;
  } else if (lB5 === '') {
    removable = true;
    var lastRow = ls.getLastRow();
    if (lastRow >= 6) {
      var below = ls.getRange(6, 2, lastRow - 5, 1).getValues();
      for (var i = 0; i < below.length; i++) {
        var v = String(below[i][0] === null || below[i][0] === undefined ? '' : below[i][0]).trim();
        if (v !== '' && !UUID_SHAPE.test(v)) {
          throw new Error('5_lookups!B5 is blank but B' + (6 + i) + ' holds "' + v + '" (not a UUID). Column B looks like data, ' +
            'not the retired PK column; inspect it by hand.');
        }
      }
    }
  }
  if (removable) {
    ls.deleteColumn(2);
    changed.push('5_lookups: removed the retired primary-key column B' + (lB5 ? ' ("' + lB5 + '")' : ' (blank header)') +
      '. "' + Migrations._cellText(ls, 5, 2) + '" is now at B.');
  } else {
    // Column B holds a real header ("Code" in the current template). Nothing to remove.
    notes.push('5_lookups has no primary-key column (B5 reads "' + lB5 + '"); nothing to do.');
  }
  return { changed: changed, notes: notes };
};

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
 * Repair sheet layouts on a workbook whose schema_version is already current. Runs every fingerprint-gated structural
 * repair (see the helpers above), then Layout.verify, and reports both. Idempotent: a workbook in shape gets a Result
 * saying so. Refuses to run when a migration is pending, because the chain is the right tool then and repairing first
 * could leave a step's fingerprint half-matched.
 *
 * Container shim: a "Repair workbook layout" menu item calls this and renders the Result via showResult_.
 *
 * @param {Spreadsheet} ss
 * @returns {Object} canonical Result (flow 'layout-repair'); data carries { changed, notes, remaining }.
 */
Migrations.repairLayout = function (ss) {
  if (!ss) throw new Error('Migrations.repairLayout: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  if (Migrations.isMigrationNeeded(ss)) {
    var pending = 'Workbook is at schema v' + Migrations.currentWorkbookVersion(ss) + '; the library expects v' +
      SDC_SCHEMA_VERSION + '. Run "Migrate workbook schema" first; repair is for workbooks already at the current version.';
    log('WARNING', 'Layout repair refused: ' + pending);
    return Result.fail({
      flow: 'layout-repair',
      correlationId: correlationId,
      message: pending,
      error: { stage: 'version-check', message: pending }
    });
  }

  log('INFO', 'Starting layout repair on schema v' + SDC_SCHEMA_VERSION);
  var changed = [], notes = [], failed = [];
  var repairs = [
    ['6_variants',            Migrations._repairVariantsStrayPk],
    ['4_complex_validations', Migrations._repairRulesDuplicatePk],
    ['5_lookups',             Migrations._repairLookupsPk]
  ];
  repairs.forEach(function (pair) {
    try {
      var r = pair[1](ss);
      Array.prototype.push.apply(changed, r.changed);
      Array.prototype.push.apply(notes, r.notes);
    } catch (e) {
      // One sheet in an unexpected shape must not stop the others from being repaired; report it alongside.
      failed.push(pair[0] + ': ' + e.message);
      log('ERROR', 'Repair of ' + pair[0] + ' failed: ' + e.message);
    }
  });

  var layout = Layout.verify(ss);
  var remaining = layout.problems;

  var lines = ['Layout repair on schema v' + SDC_SCHEMA_VERSION];
  lines.push('');
  lines.push(changed.length ? 'Changed:' : 'Changed: nothing');
  changed.forEach(function (c) { lines.push('  -> ' + c); });
  if (failed.length) { lines.push(''); lines.push('Could not repair:'); failed.forEach(function (f) { lines.push('  -> ' + f); }); }
  lines.push('');
  lines.push(remaining.length ? 'Layout.verify still reports:' : 'Layout.verify: every check passed.');
  remaining.forEach(function (p) { lines.push('  -> ' + p); });
  if (remaining.length) {
    lines.push('');
    lines.push('A remaining problem means a header cell was edited or a column was moved by hand; restore it to the text shown.');
  }
  var message = lines.join('\n');

  var ok = failed.length === 0 && remaining.length === 0;
  log(ok ? 'SUCCESS' : 'WARNING', 'Layout repair finished. Changed: ' + changed.length + ', failed: ' + failed.length +
    ', remaining problems: ' + remaining.length + '.');

  if (ok) {
    return Result.ok({
      flow: 'layout-repair',
      correlationId: correlationId,
      message: message,
      data: { changed: changed, notes: notes, remaining: [] }
    });
  }
  return Result.fail({
    flow: 'layout-repair',
    correlationId: correlationId,
    message: message,
    warnings: failed,
    error: {
      stage: 'layout-repair',
      message: (failed.length ? failed.length + ' repair(s) failed. ' : '') +
               (remaining.length ? remaining.length + ' layout problem(s) remain.' : '')
    },
    data: { changed: changed, notes: notes, remaining: remaining }
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

  // The value cell is forced to plain text BEFORE writing. In an automatic-format cell a version string that looks
  // like a number is coerced on write - '1.10' becomes 1.1, which then reads back as '1.1' and re-walks the chain
  // from the wrong step. Versions '1.1' .. '1.9' never exposed this; '1.10' does.
  var data = devSheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][1] === 'meta' && data[i][2] === 'schema_version') {
      devSheet.getRange(i + 1, 4).setNumberFormat('@').setValue(String(version));
      return;
    }
  }

  // Not found - append it. Column layout matches the existing developer
  // settings convention: A=description (optional), B=category, C=key, D=value.
  devSheet.appendRow(['', 'meta', 'schema_version', '']);
  devSheet.getRange(devSheet.getLastRow(), 4).setNumberFormat('@').setValue(String(version));
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
