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
 * Which sheets get one, and where, is declared in PRIMARY_KEY_COLUMNS
 * (003_Schema.gs) and verified against the workbook at preflight
 * (Layout.verify). Nothing in this file changes sheet structure.
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
 * One-time setup for a fresh workbook: write the PK header into each sheet's
 * declared (blank) PK column, backfill UUIDs for existing data rows, apply
 * column protection, hide.
 *
 * Idempotent and non-structural - safe to call repeatedly. It never inserts
 * or deletes columns: a sheet whose declared PK column is occupied by
 * something else is reported as skipped (see _ensureColumn), because the
 * mismatch is between the template and PRIMARY_KEY_COLUMNS and must be
 * resolved by a migration.
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
var UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ensure the PK header sits at cfg.colIndex on the header row. NEVER inserts a column.
 *
 * Outcomes:
 *   header cell already reads cfg.fieldName          -> nothing to do.
 *   header cell blank and the column below is empty
 *   or already UUID-shaped                            -> claim it: write the header (and the two note cells above it
 *                                                        when those cells are blank).
 *   cfg.fieldName found in another column             -> throw. PRIMARY_KEY_COLUMNS and the template disagree.
 *   header cell holds any other text                  -> throw. The declared PK column is occupied.
 *
 * History: until library 1.8.0 this function inserted a new column whenever the header did not match. Combined with
 * unreconciled PRIMARY_KEY_COLUMNS entries it inserted a stray column into 6_variants and 4_complex_validations and
 * wrote its note text into data rows of 5_lookups (schema 1.7 migration repairs all three). A menu action must not
 * change sheet structure; that is what migrations are for.
 */
PrimaryKey._ensureColumn = function(sheet, cfg) {
  var headerRow = cfg.dataStartRow - 1;
  var pkCol     = cfg.colIndex + 1;
  var width     = Math.max(sheet.getLastColumn(), pkCol);
  var headers   = sheet.getRange(headerRow, 1, 1, width).getValues()[0]
                       .map(function(v) { return String(v === null || v === undefined ? '' : v).trim(); });

  if (headers[cfg.colIndex] === cfg.fieldName) return;

  var elsewhere = headers.indexOf(cfg.fieldName);
  if (elsewhere >= 0) {
    throw new Error('"' + cfg.fieldName + '" is at column ' + (elsewhere + 1) + ' of "' + cfg.sheetName +
      '" row ' + headerRow + ', but PRIMARY_KEY_COLUMNS declares column ' + pkCol +
      '. Reconcile the table or the template (via a migration); not inserting a column.');
  }
  if (headers[cfg.colIndex] !== '') {
    throw new Error('"' + cfg.sheetName + '" row ' + headerRow + ', column ' + pkCol + ' holds "' +
      headers[cfg.colIndex] + '", not a primary-key header. Refusing to insert a column; structural changes belong in a migration.');
  }

  // Header cell is blank. Claim the column only if nothing below contradicts that it is (or can be) the PK column.
  var lastRow = sheet.getLastRow();
  if (lastRow >= cfg.dataStartRow) {
    var below = sheet.getRange(cfg.dataStartRow, pkCol, lastRow - cfg.dataStartRow + 1, 1).getValues();
    for (var i = 0; i < below.length; i++) {
      var v = String(below[i][0] === null || below[i][0] === undefined ? '' : below[i][0]).trim();
      if (v !== '' && !UUID_SHAPE.test(v)) {
        throw new Error('"' + cfg.sheetName + '" column ' + pkCol + ' has a blank header but row ' +
          (cfg.dataStartRow + i) + ' holds "' + v + '" (not a UUID). Refusing to claim it as the PK column.');
      }
    }
  }

  sheet.getRange(headerRow, pkCol).setValue(cfg.fieldName);
  var noteIfBlank = function(row, text) {
    if (row < 1) return;
    var cell = sheet.getRange(row, pkCol);
    if (String(cell.getValue()).trim() === '') cell.setValue(text);
  };
  noteIfBlank(headerRow - 1, 'Do not edit.');
  noteIfBlank(headerRow - 2, 'Primary key (UUID)');

  console.log('Claimed PK column ' + pkCol + ' in "' + cfg.sheetName + '" (header written at row ' + headerRow + ').');
};
/**
 * Backfill UUIDs for rows whose key column (cfg.keyColIndex - Field name, Table name, ...) is non-blank but whose PK
 * cell is empty. Returns the number of rows stamped. Rows with a blank key are not records (pre-formatted checkbox
 * rows, spacer rows) and are never stamped.
 */
PrimaryKey._backfillSheet = function(sheet, cfg) {
  var lastRow = sheet.getLastRow();
  if (lastRow < cfg.dataStartRow) return 0;

  var pkCol      = cfg.colIndex + 1;
  var dataRows   = lastRow - cfg.dataStartRow + 1;
  var pkRange    = sheet.getRange(cfg.dataStartRow, pkCol, dataRows, 1);
  var pkValues   = pkRange.getValues();
  var keyCol     = cfg.keyColIndex + 1;
  var keyValues  = sheet.getRange(cfg.dataStartRow, keyCol, dataRows, 1).getValues();

  var stamped = 0;
  for (var i = 0; i < dataRows; i++) {
    var hasName = String(keyValues[i][0]).trim() !== '';
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