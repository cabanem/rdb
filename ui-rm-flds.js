/**
 * lib_sdc 1.10.0 — remove "Application name" and "Expected completion date" from 1_customer.
 * Schema 1.8 → 1.9 (two rows and two named ranges leave the workbook). Payload 10.0 → 11.0 (two wire fields leave).
 *
 * Sectioned by file. Apply top to bottom. Anything not listed here follows the registry automatically:
 * Customer.read / readOne / serialize / ensureNamedRanges, Preflight 5a/5b, Drive.serializeConfig's _customer block.
 */


// =====================================================================================================================
// 003_Schema.js
// =====================================================================================================================

// --- Labels: delete these two lines ---------------------------------------------------------------------------------
//   applicationName: 'Application name',
//   expectedDate: 'Expected completion date',

// --- CUSTOMER_FIELDS: delete these two entries ----------------------------------------------------------------------
//   Object.freeze({ key: 'applicationName', rangeName: 'cfg_application_name', ... }),
//   Object.freeze({ key: 'expectedDate',    rangeName: 'cfg_expected_date',    ... }),

// --- Load-time guard: the Labels key list becomes ------------------------------------------------------------------
  ['customerName', 'analystEmail', 'targetVMS', 'folderId', 'reminderDays', 'supplierInstructions', 'lastDayForSubmission',
    'kickoffEmailBody', 'hasSeedData', 'seedDataDriveId', 'seedDataSheetName', 'seedDataIndexKey', 'seedDataHeaderRow', 'seedDataFirstDataRow',
    'variantCount'].forEach(function (k) {
      if (!(k in Labels)) {
        throw new Error('Schema.gs: Labels.' + k + ' is referenced by library code but not defined.');
      }
    });


// =====================================================================================================================
// 002_Migrations.js
// =====================================================================================================================

// --- 1.2 → 1.3 step: the historical label must not reference Labels.expectedDate any more -----------------------------
// Per the file's own rule, retired wording lives in the migration that owned it. Three edits in that step:
//
//   var dateLabelNorm = Labels.expectedDate.toLowerCase().trim();
//     →  var EXPECTED_DATE_LABEL_1_3 = 'Expected completion date';   // retired in 1.9; literal kept for the 1.2→1.3 path
//        var dateLabelNorm = EXPECTED_DATE_LABEL_1_3.toLowerCase().trim();
//   sheet.getRange(newRow, 2).setValue(Labels.expectedDate);
//     →  sheet.getRange(newRow, 2).setValue(EXPECTED_DATE_LABEL_1_3);
//   changed.push('Added field row "' + Labels.expectedDate + '" ...
//     →  changed.push('Added field row "' + EXPECTED_DATE_LABEL_1_3 + '" ...
//
// (A workbook migrating 1.2 → 1.9 will gain the row in the 1.3 step and lose it again in the 1.9 step. Correct, if odd.)

// --- Append to MIGRATION_CHAIN after the 1.7 → 1.8 step ---------------------------------------------------------------
  // 1.8 -> 1.9
  {
    from: '1.8',
    to: '1.9',
    run: function (ss) {
      // "Application name" and "Expected completion date" leave 1_customer. Each field is located by its named range
      // (the read contract) with the retired label text as the fallback, its row is deleted, and the named range is
      // removed. Sheets re-anchors every other named range on row deletion, so the remaining cfg_* ranges survive.
      // Column B carries a printed row number per field; those are renumbered when they are plain integers.
      var changed = [];
      var notes = [];
      var sheetName = DEFAULT_SHEETS.customer;
      var sheet = ss.getSheetByName(sheetName);
      if (!sheet) throw new Error("'" + sheetName + "' is missing; cannot migrate schema to 1.9.");

      var RETIRED = [
        { rangeName: 'cfg_application_name', label: 'Application name' },
        { rangeName: 'cfg_expected_date',    label: 'Expected completion date' }
      ];

      // Resolve rows first, delete bottom-up so earlier deletions do not shift later targets.
      var targets = [];
      RETIRED.forEach(function (f) {
        var row = null;
        try {
          var r = ss.getRangeByName(f.rangeName);
          if (r && r.getSheet().getName() === sheetName) row = r.getRow();
        } catch (ignore) { /* broken range: fall through to label */ }
        if (row === null) {
          var cell = Util.findLabelCell(sheet, f.label);
          if (cell) row = cell.row;
        }
        if (row === null) { notes.push('"' + f.label + '" not found (named range or label); nothing to remove.'); return; }
        targets.push({ row: row, f: f });
      });
      targets.sort(function (a, b) { return b.row - a.row; });

      targets.forEach(function (t) {
        sheet.deleteRow(t.row);
        changed.push('Deleted 1_customer row ' + t.row + ' ("' + t.f.label + '").');
        try {
          if (ss.getRangeByName(t.f.rangeName)) { ss.removeNamedRange(t.f.rangeName); changed.push('Removed named range ' + t.f.rangeName + '.'); }
        } catch (e) { notes.push('Could not remove named range ' + t.f.rangeName + ': ' + e.message); }
      });

      // Renumber column B where it holds plain integers (v0.9.9 layout: B = #, C = label, D = value).
      if (targets.length) {
        var anchor = ss.getRangeByName('cfg_customer_name');
        if (anchor) {
          var first = anchor.getRow(), last = sheet.getLastRow(), n = 0, renumbered = 0;
          for (var r = first; r <= last; r++) {
            var cell = sheet.getRange(r, 2), v = cell.getValue();
            if (typeof v === 'number' && Number.isInteger(v)) { n++; if (v !== n) { cell.setValue(n); renumbered++; } }
          }
          if (renumbered) changed.push('Renumbered ' + renumbered + ' row label(s) in column B.');
        }
      }

      notes.push('Payload 11.0 no longer sends application_name or expected_date; the Workato side must not require them.');
      return { changed: changed, notes: notes };
    }
  }


// =====================================================================================================================
// 005_Preflight.js
// =====================================================================================================================

// --- Delete block 5c entirely (expected-date shape check). 5d (lastDayForSubmission) stays. -------------------------
//   // 5c. Expected date (present but not a usable date).
//   var rawExpectedDate = read.raw.expectedDate;
//   ...
//   }


// =====================================================================================================================
// 003_Payload.js
// =====================================================================================================================

// --- Payload.provision: _requireArgs list and two wire keys -----------------------------------------------------------
Payload.provision = function (args) {
  Payload._requireArgs(args,
    ['correlationId', 'clientName', 'analystEmail', 'configFileId',
      'configJsonFileId', 'configFingerprint', 'isInitial', 'outputDriveFolderId', 'lastDayForSubmission',
      'reminderDays', 'hasSeedData', 'spreadsheetId'], 'provision');

  return {
    correlation_id: args.correlationId,
    client_name: args.clientName,
    analyst_email: args.analystEmail,
    last_day_for_submission: args.lastDayForSubmission,
    target_vms: args.targetVms || '',
    config_file_id: args.configFileId,
    drive_id_config_json: args.configJsonFileId,
    config_fingerprint: args.configFingerprint,
    template_file_ids: args.templateFileIds || [],
    is_initial: Boolean(args.isInitial),
    output_drive_folder_id: args.outputDriveFolderId,
    reminder_days: args.reminderDays,
    supplier_instructions: args.supplierInstructions || '',
    kick_off_email_body: args.kickoffEmailBody,
    timestamp: new Date().toISOString(),
    has_seeded_data: args.hasSeedData || false,
    seeded_data_drive_id: args.seedDataDriveId || '',
    seeded_data_index_key: args.seedDataIndexKey || '',
    seeded_data_sheet_name: args.seedDataSheetName || '',
    seeded_data_header_row: Payload._intOrNull(args.seedDataHeaderRow),
    seeded_data_first_data_row: Payload._intOrNull(args.seedDataFirstDataRow),
    seeded_data_xlsx_file_id: args.seedDataXlsxFileId || '',
    spreadsheet_id: args.spreadsheetId
  };
};
// Also drop the `@param args.expectedDate` line from the doc block above it.


// =====================================================================================================================
// 005_Provision.js
// =====================================================================================================================

// --- Payload.provision call (step 7): delete these two lines ---------------------------------------------------------
//   expectedDate: pf.expectedDate,
//   applicationName: pf.applicationName,
//
// --- Result.data, both the `mode: 'unchanged'` block and the success block: delete ---------------------------------
//   applicationName: pf.applicationName,


// =====================================================================================================================
// 008_Version.js
// =====================================================================================================================

var Version = Object.freeze({
  LIBRARY: '1.10.0',
  PAYLOAD: '11.0',
  SCHEMA: '1.9'
});

// --- Payload history: append -----------------------------------------------------------------------------------------
//  11.0 - Provision payload: removed application_name and expected_date. Validate and portal-invite payloads unchanged.
//
// --- Schema history: append ------------------------------------------------------------------------------------------
//   1.9 - "Application name" and "Expected completion date" removed from 1_customer (rows deleted, cfg_application_name
//         and cfg_expected_date named ranges removed, column B renumbered). Labels and CUSTOMER_FIELDS drop both keys;
//         the 1.2→1.3 migration keeps the retired date label as a literal.


// =====================================================================================================================
// app_sdc-shim (container)
// =====================================================================================================================

// --- main.js resultDetails_: delete ---------------------------------------------------------------------------------
//   if (d.applicationName) lines.push('Application: ' + d.applicationName);
//
// --- main.js debugCustomerSheet(): sections 2 and 3 are built around L.expectedDate. Either delete the function
//     (it predates named ranges; Customer.read's `unresolved` list now answers the question it was written for) or
//     point sections 2–3 at L.lastDayForSubmission. Section 1 needs no change — it iterates Labels.
