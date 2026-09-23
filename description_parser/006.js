/**
 * @file 006_PrimaryKey.gs
 * Primary-key column setup and backfill.
 *
 * No trigger. PKs are stamped during serialization (orchestrators call
 * backfill before Drive.serializeConfig). This is correct because nothing
 * in the workbook references rows by PK - cross-sheet references use
 * field names. The PK is a Workato-side identifier only, written back
 * to the sheet so it remains stable across re-publishes.
 *
 * Public:
 *   PrimaryKey.setupColumns(ss) -> Result   (canonical Result shape)
 *   PrimaryKey.backfill(ss)     -> { ok, stamped: { sheetName: count }, totalStamped }
 *
 * Note: backfill is exempt from the canonical Result shape. It's an
 * internal step result consumed by orchestrators (Provision, Validate),
 * not a flow returned to the container.
 */

var PrimaryKey = {};

// --- Public API ------------------------------------------------------
/**
 * One-time setup for a fresh workbook: insert PK columns where missing,
 * backfill UUIDs for existing data rows, apply column protection, hide.
 *
 * Idempotent - safe to call repeatedly. If a sheet already has the PK
 * column with the correct header, no column insertion happens.
 *
 * Returns a canonical Result. The container shim renders the alert
 * via showResult_ uniformly with all other flows.
 *
 * @param {Spreadsheet} ss
 * @returns {Object} canonical Result
 */
PrimaryKey.setupColumns = function(ss) {
  if (!ss) throw new Error('PrimaryKey.setupColumns: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  log('INFO', 'Starting PK column setup...');

  var configured = [];
  var skipped    = [];

  PRIMARY_KEY_COLUMNS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) {
      skipped.push({ sheetName: cfg.sheetName, reason: 'Sheet not found.' });
      log('WARNING', 'Skipped "' + cfg.sheetName + '": sheet not found.');
      return;
    }

    try {
      PrimaryKey._ensureColumn(sheet, cfg);
      PrimaryKey._backfillSheet(sheet, cfg);
      PrimaryKey._applyProtection(sheet, cfg);
      configured.push(cfg.sheetName);
    } catch (e) {
      skipped.push({ sheetName: cfg.sheetName, reason: e.message });
      log('WARNING', 'Skipped "' + cfg.sheetName + '": ' + e.message);
    }
  });

  var message = 'PK setup complete.\n\n'
    + 'Configured: ' + (configured.length ? configured.join(', ') : 'none') + '\n'
    + 'Skipped: '    + (skipped.length    ? skipped.map(function(s) {
        return s.sheetName + ' (' + s.reason + ')';
      }).join(', ') : 'none');

  var ok = skipped.length === 0;
  log(ok ? 'SUCCESS' : 'WARNING',
      'PK setup finished. Configured: ' + configured.length + ', skipped: ' + skipped.length + '.');

  // Skipped entries become warnings on the Result for symmetry with
  // Provision's audit-share warnings. The structured detail lives on data.
  var warnings = skipped.map(function(s) {
    return s.sheetName + ': ' + s.reason;
  });

  if (ok) {
    return Result.ok({
      flow:          'primaryKeySetup',
      correlationId: correlationId,
      message:       message,
      data: {
        configured: configured,
        skipped:    skipped
      },
      warnings: warnings
    });
  }

  // Partial-success / no-success: present as a failure so the container
  // surfaces it as such, but carry the per-sheet detail in error.message
  // and the warnings array. error.stage is 'setup' - this isn't a
  // pipeline-style failure with a single failing stage.
  return Result.fail({
    flow:          'primaryKeySetup',
    correlationId: correlationId,
    message:       message,
    warnings:      warnings,
    error: {
      stage:   'setup',
      message: skipped.length + ' sheet(s) could not be configured.'
    }
  });
};
/**
 * Stamp UUIDs into PK columns for any rows that have content but no ID.
 * Idempotent and cheap when nothing needs stamping. Called by orchestrators
 * before serialization.
 *
 * Writes back to the sheet so IDs are stable across re-publishes.
 *
 * Internal step result - NOT a canonical Result. Consumed by
 * Provision.run and Validate.run, not returned to the container.
 *
 * @param {Spreadsheet} ss
 * @returns {{ok: boolean, stamped: Object<string, number>, totalStamped: number}}
 */
PrimaryKey.backfill = function(ss) {
  if (!ss) throw new Error('PrimaryKey.backfill: ss is required.');

  var stamped      = {};
  var totalStamped = 0;

  PRIMARY_KEY_COLUMNS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) {
      stamped[cfg.sheetName] = 0;
      return;
    }

    var count = PrimaryKey._backfillSheet(sheet, cfg);
    stamped[cfg.sheetName] = count;
    totalStamped += count;
  });

  return { ok: true, stamped: stamped, totalStamped: totalStamped };
};


// --- Private helpers -------------------------------------------------
/**
 * Ensure the PK column exists at cfg.colIndex with the correct header.
 * If the existing header doesn't match, insert a new column before it.
 * If a column is inserted, also writes a "Do not edit." note above the
 * header and "Primary key (UUID)" two rows above (when those rows exist).
 */
PrimaryKey._ensureColumn = function(sheet, cfg) {
  var headerRow = cfg.dataStartRow - 1;
  var pkCol     = cfg.colIndex + 1;

  var currentHeader = sheet.getRange(headerRow, pkCol).getValue();
  if (String(currentHeader).trim() === cfg.fieldName) return;

  sheet.insertColumnBefore(pkCol);
  sheet.getRange(headerRow, pkCol).setValue(cfg.fieldName);

  if (headerRow >= 2) sheet.getRange(headerRow - 1, pkCol).setValue('Do not edit.');
  if (headerRow >= 3) sheet.getRange(headerRow - 2, pkCol).setValue('Primary key (UUID)');

  console.log('Inserted PK column in "' + cfg.sheetName + '" at column ' + pkCol + '.');
};
/**
 * Backfill UUIDs for rows that have content (in any non-PK column) but
 * an empty PK cell. Returns the number of rows stamped.
 */
PrimaryKey._backfillSheet = function(sheet, cfg) {
  var lastRow = sheet.getLastRow();
  if (lastRow < cfg.dataStartRow) return 0;

  var pkCol      = cfg.colIndex + 1;
  var dataRows   = lastRow - cfg.dataStartRow + 1;
  var pkRange    = sheet.getRange(cfg.dataStartRow, pkCol, dataRows, 1);
  var pkValues   = pkRange.getValues();
  // The row's "name" is the first data column, which sits right AFTER the pk column in the current layout
  // (A = definition column, blank on data rows; B = _pk_...; C = Field name / Target field / Table name / ...).
  // The old rule "pkCol === 1 ? 2 : 1" read column A for every tab and so never found a name to stamp against.
  var nameCol    = pkCol + 1;
  var nameValues = sheet.getRange(cfg.dataStartRow, nameCol, dataRows, 1).getValues();

  var stamped = 0;
  for (var i = 0; i < dataRows; i++) {
    var hasName = String(nameValues[i][0]).trim() !== '';
    var hasPk   = String(pkValues[i][0]).trim() !== '';
    if (hasName && !hasPk) {
      pkValues[i][0] = Utilities.getUuid();
      stamped++;
    }
  }

  if (stamped > 0) {
    pkRange.setValues(pkValues);
    console.log('Stamped ' + stamped + ' UUIDs in "' + cfg.sheetName + '".');
  }
  return stamped;
};
/**
 * Apply warning-only protection on the PK column and hide it.
 * Idempotent - re-running adjusts editors and warning-only state on
 * an existing protection rather than creating duplicates.
 */
PrimaryKey._applyProtection = function(sheet, cfg) {
  var pkCol = cfg.colIndex + 1;

  var protection = sheet.getRange(1, pkCol, sheet.getMaxRows(), 1)
    .protect()
    .setDescription(cfg.fieldName + ' - immutable primary key');

  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  protection.setWarningOnly(true);

  sheet.hideColumns(pkCol);
  console.log('Protected and hid PK column in "' + cfg.sheetName + '".');
};
