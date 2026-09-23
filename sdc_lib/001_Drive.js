/**
 * @file 001_Drive.gs (SDC library)
 * Serialization of workbook config to Drive, plus folder resolution, cleanup, and Drive sharing.
 *
 * Public:
 *   Drive.serializeConfig(ss, config, options)       → { fileId, baseOutput }
 *   Drive.resolveDestinationFolder(ss, config)       → Folder
 *   Drive.shareWithEditors(fileId, emails)           → { granted, failed }
 *   Drive.shareWithIntegrationAccount(fileId, email) → void (throws)
 *   Drive.cleanupOldFiles(folder, prefixes)          → void
 *   Drive.normalizeDates(data, tz)                   → array of arrays
 *   Drive.buildFieldVisibilityMap(formData)          → { fieldName: bool }
 *   Drive.buildFieldHiddenMap(fieldsData)          → { fieldName: bool }
 *
 * The last three are utilities reused by Variant.gs. They live here because their first home was Drive.serializeConfig; once a second
 * caller appeared, the underscore prefix was no longer accurate.
 *
 * Envelope shape (co-mingled, underscore-prefixed metadata):
 *   {
 *     _meta:                     { schema_version, library_version, payload_version, purpose, workbook_id, serialized_at },
 *     _field_visibility:         { fieldName: bool, ... },
 *     _field_supplier_hidden:    { fieldName: bool, ... },
 *     _customer:                 { values: { <CUSTOMER_FIELDS key>: value }, unresolved: [keys] }
 *     "1_customer": [[...]], "2_suppliers": [[...]], ...
 *   }
 */

var Drive = {};

// --- Constants -------------------------------------------------------
var FILE_PREFIX_PROVISION = 'config_';
var FILE_PREFIX_VALIDATE = 'validate_';

// --- Public API ------------------------------------------------------
/**
 * Serialize the workbook's connector-relevant sheets to a JSON file on Drive.
 *
 * Returns the file ID AND the in-memory envelope (baseOutput) so callers that need to derive variant
 * slices from the same data can avoid re-reading sheets. Variant.serializeAll uses this; every provision
 * and validate run reads each connector sheet exactly once across both.
 *
 * Cleanup rule (asymmetric):
 *   - purpose='provision' → trashes ALL prior config_{ssId}_* AND validate_{ssId}_* for this workbook.
 *     A successful provision invalidates everything prior.
 *   - purpose='validate'  → trashes nothing. User manages validate-file accumulation manually; validation is a preview, not a commit.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config        - From Config.build(ss).
 * @param {Object}      [options]
 * @param {string}      [options.purpose='provision'] - 'provision' | 'validate'.
 * @returns {{fileId: string, baseOutput: Object}}
 */
Drive.serializeConfig = function (ss, config, options) {
  if (!ss) throw new Error('Drive.serializeConfig: ss is required.');
  if (!config) throw new Error('Drive.serializeConfig: config is required.');

  var opts = options || {};
  var purpose = opts.purpose || 'provision';
  if (purpose !== 'provision' && purpose !== 'validate') {
    throw new Error('Drive.serializeConfig: purpose must be "provision" or "validate".');
  }

  var tz = ss.getSpreadsheetTimeZone();
  var output = {};

  // 1. Read connector-relevant sheets in canonical order (stable JSON output)
  for (var i = 0; i < CONNECTOR_SHEETS_ORDER.length; i++) {
    var name = CONNECTOR_SHEETS_ORDER[i];
    var sheet = ss.getSheetByName(name);
    if (!sheet) continue;

    var data = sheet.getDataRange().getValues();
    output[name] = Drive.normalizeDates(data, tz);
  }

  // 2. Derived: field visibility from 7_form
  if (output['7_form']) {
    output['_field_visibility'] = Drive.buildFieldVisibilityMap(output['7_form']);
  }

  // 2b. Derived: supplier read-only flags from 4_fields (field property, variant-independent). Sibling to _field_visibility.
  if (output['4_fields']) {
    output['_field_supplier_hidden'] = Drive.buildFieldHiddenMap(output['4_fields']);
  }

  // 2c. Derived: typed 1_customer values via the named-range read (Customer.serialize). This is the connector's
  //     source for the customer block as of schema 1.6; the raw 1_customer grid above remains for audit and for
  //     pre-1.6 connector fallback. Same read as the provision webhook, so the two cannot drift.
  output['_customer'] = Customer.serialize(ss, config);

  // 2d. Content fingerprint: Computed over `output` BEFORE _meta is appended, so it covers every serialized sheet + derived map
  var fingerprint = Util.sha256Hex(JSON.stringify(output));

  // 3. Envelope metadata
  output['_meta'] = {
    schema_version: config.schemaVersion,
    library_version: SDC_LIBRARY_VERSION,
    payload_version: SDC_PAYLOAD_VERSION,
    purpose: purpose,
    workbook_id: ss.getId(),
    serialized_at: new Date().toISOString(),
    config_fingerprint: fingerprint
  };

  // 4. Resolve destination
  var folder = Drive.resolveDestinationFolder(ss, config, { purpose: purpose });

  // 5. Cleanup — asymmetric per workflow rule.
  //    Variant files are cleaned up by Variant.serializeAll using the
  //    same rule, so they don't need to be in this list.
  var ssId = ss.getId();
  if (purpose === 'provision') {
    Drive.cleanupOldFiles(folder, [
      FILE_PREFIX_PROVISION + ssId + '_',
      FILE_PREFIX_VALIDATE + ssId + '_'
    ]);
  }

  // 6. Write
  var prefix = (purpose === 'validate' ? FILE_PREFIX_VALIDATE : FILE_PREFIX_PROVISION)
    + ssId + '_';
  var stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  var fileName = prefix + stamp + '.json';
  var blob = Utilities.newBlob(JSON.stringify(output), 'application/json', fileName);
  var file = folder.createFile(blob);

  return { fileId: file.getId(), baseOutput: output };
};

/**
 * Resolve where serialized config should land.
 *
 * Purpose-aware (v1.4):
 *   - purpose='provision' → the shared export folder (configExportFolderId,
 *     falling back to the workbook's parent). These are the durable artifacts.
 *   - purpose='validate'  → a scratch folder in the RUNNING USER's own Drive.
 *     Validate/preview JSONs are transient, and Workato reads them BY FILE ID
 *     via shareWithIntegrationAccount — folder location is irrelevant to the
 *     integration. Writing to user-owned space removes the folder-ACL
 *     requirement for ad-hoc flows entirely: any editor of the workbook can
 *     validate/preview with zero access to the provisioning folder.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config
 * @param {Object}      [options]
 * @param {string}      [options.purpose='provision'] - 'provision' | 'validate'
 * @returns {Folder}
 * @throws If the provision path resolves to no folder.
 */
Drive.resolveDestinationFolder = function (ss, config, options) {
  var purpose = (options && options.purpose) || 'provision';

  if (purpose === 'validate') {
    return Drive._getOrCreateUserScratchFolder();
  }

  // --- provision path: unchanged from v1.3 ---
  var explicitId = String(
    (config && config.storage && config.storage.configExportFolderId) || ''
  ).trim();

  if (explicitId) {
    try {
      return DriveApp.getFolderById(explicitId);
    } catch (e) {
      throw new Error(
        'Could not open the destination folder ' +
        '(storage.configExportFolderId = "' + explicitId + '"). ' +
        'Verify the folder ID and that the running user has access. ' +
        'Underlying error: ' + e.message
      );
    }
  }

  var ssFile = DriveApp.getFileById(ss.getId());
  var parents = ssFile.getParents();

  if (!parents.hasNext()) {
    throw new Error(
      'Cannot determine a destination folder for the config JSON. ' +
      'The running user has no visible parent folder for this spreadsheet, ' +
      'and storage.configExportFolderId is not set. ' +
      'Add an explicit folder ID under category "storage", key "configExportFolderId" ' +
      'in _developer_settings.'
    );
  }

  return parents.next();
};

/**
 * Grant editor access on a Drive file to a list of emails. Non-fatal:
 * collects per-email outcomes. Use for the human "audit/visibility" share list.
 *
 * @param {string}   fileId
 * @param {string[]} emails
 * @returns {{granted: string[], failed: Array<{email: string, error: string}>}}
 */
Drive.shareWithEditors = function (fileId, emails) {
  var result = { granted: [], failed: [] };
  if (!emails || emails.length === 0) return result;

  var file = DriveApp.getFileById(fileId);

  for (var i = 0; i < emails.length; i++) {
    var email = emails[i];
    try {
      file.addEditor(email);
      result.granted.push(email);
    } catch (e) {
      result.failed.push({ email: email, error: e.message });
      console.warn('Could not share with ' + email + ': ' + e.message);
    }
  }
  return result;
};

/**
 * Grant editor access to the Workato OAuth account and verify the share landed.
 * Fatal on failure — Workato cannot read the file otherwise.
 *
 * @throws If the share fails or cannot be verified.
 */
Drive.shareWithIntegrationAccount = function (fileId, email) {
  var file = DriveApp.getFileById(fileId);

  try {
    file.addEditor(email);
  } catch (e) {
    throw new Error(
      'Could not grant Workato OAuth account (' + email + ') editor access on the ' +
      'config JSON file. Workato will not be able to read it. ' +
      'Underlying error: ' + e.message
    );
  }

  // Verify: addEditor can succeed silently when the address is malformed
  // or blocked by domain policy. Confirm the address is on the editor list.
  var target = email.trim().toLowerCase();
  var editors = file.getEditors().map(function (u) {
    return String(u.getEmail()).toLowerCase();
  });

  if (editors.indexOf(target) === -1) {
    throw new Error(
      'Share with Workato OAuth account (' + email + ') returned without error, ' +
      'but the address is not present on the file\'s editor list. This usually ' +
      'indicates a domain sharing policy restriction or an invalid address. ' +
      'Verify sharing.integrationAccountEmail in _developer_settings.'
    );
  }

  console.log('Granted and verified editor access for Workato OAuth account: ' + email);
};

/**
 * Copy a single named sheet from a source spreadsheet into a new, standalone XLSX file on Drive. Returns the new file's ID.
 *
 * Mechanism: no Drive/Sheets export yields a single-sheet XLSX directly (xlsx export is always whole-workbook;
 * only CSV/TSV honor a per-sheet gid). So we copy the one sheet into a fresh throwaway Google Sheet, export THAT to XLSX,
 * then trash it. Sheet.copyTo carries values, formatting, and data validation; it does NOT carry cross-sheet formula
 * references (they would point at sheets absent from the new single-sheet workbook). For incumbent/seed data tables this is the desired behavior.
 *
 * Assumes the source is a native Google Sheet. A source that is itself an uploaded .xlsx cannot be opened by SpreadsheetApp.openById and will
 * throw here; convert it to a Google Sheet first if that case appears.
 *
 * Requires the Drive scope (already in use library-wide) for the export fetch's OAuth token.
 *
 * @param {string} sourceFileId - Drive ID of the source spreadsheet.
 * @param {string} sheetName    - Tab to extract (matched exactly).
 * @param {Object} [options]
 * @param {Folder} [options.destinationFolder] - Where to write the XLSX. Defaults to the source file's first parent.
 * @param {string} [options.fileName]          - Output name WITHOUT extension. Defaults to sheetName.
 * @returns {{fileId: string, fileName: string}}
 * @throws  If the source can't be opened, the named sheet is absent, or export fails.
 */
Drive.copySheetToXlsx = function (sourceFileId, sheetName, options) {
  if (!sourceFileId) throw new Error('Drive.copySheetToXlsx: sourceFileId is required.');
  if (!sheetName) throw new Error('Drive.copySheetToXlsx: sheetName is required.');

  var opts = options || {};

  // 1. Open source + locate the named sheet.
  var source;
  try {
    source = SpreadsheetApp.openById(sourceFileId);
  } catch (e) {
    throw new Error(
      'Could not open the seed-data source spreadsheet (id "' + sourceFileId + '"). ' +
      'Verify the ID, that the running user has access, and that it is a native ' +
      'Google Sheet (not an uploaded .xlsx). Underlying error: ' + e.message
    );
  }

  var srcSheet = source.getSheetByName(sheetName);
  if (!srcSheet) {
    throw new Error(
      'Sheet "' + sheetName + '" was not found in the seed-data source ' +
      '(id "' + sourceFileId + '"). Check the sheet name in the customer tab.'
    );
  }

  // 2. Copy just that sheet into a fresh throwaway spreadsheet.
  var temp = SpreadsheetApp.create('._seed_export_tmp_' + Utilities.getUuid());
  try {
    var originalSheets = temp.getSheets();          // the default sheet(s)
    var copied = srcSheet.copyTo(temp);             // arrives as "Copy of <name>"
    originalSheets.forEach(function (s) { temp.deleteSheet(s); });
    copied.setName(sheetName);                      // after delete: no name collision
    SpreadsheetApp.flush();                         // persist before the export read

    // 3. Export the throwaway workbook as XLSX.
    var exportUrl = 'https://docs.google.com/spreadsheets/d/' + temp.getId() +
      '/export?format=xlsx';
    var resp = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('XLSX export returned HTTP ' + resp.getResponseCode() + ': ' +
        String(resp.getContentText() || '').substring(0, 300));
    }

    // 4. Write the XLSX into the destination folder.
    var folder = opts.destinationFolder;
    if (!folder) {
      var parents = DriveApp.getFileById(sourceFileId).getParents();
      if (!parents.hasNext()) {
        throw new Error('Drive.copySheetToXlsx: no destinationFolder given and the ' +
          'source file has no accessible parent folder to fall back to.');
      }
      folder = parents.next();
    }
    var baseName = String(opts.fileName || sheetName).replace(/\.xlsx$/i, '');
    var blob = resp.getBlob().setName(baseName + '.xlsx');
    var outFile = folder.createFile(blob);

    return { fileId: outFile.getId(), fileName: outFile.getName() };
  } finally {
    // 5. Always trash the throwaway, even if export/write threw.
    try {
      DriveApp.getFileById(temp.getId()).setTrashed(true);
    } catch (e) {
      console.warn('Drive.copySheetToXlsx: could not trash temp spreadsheet ' +
        temp.getId() + ': ' + e.message);
    }
  }
};

// --- Public utilities ------------------------------------------------
/**
 * Normalize Date instances to yyyy-MM-dd strings. Currently date-only; if a datetime field is added to
 * any connector sheet, branch on cell.getHours()/getMinutes() here to preserve time. Numeric date-formatted
 * cells come through as numbers (formatting is presentation-only) and are not normalized.
 *
 * Public so Variant.gs can call it on its own freshly-read base sheets (when called without baseOutput);
 * kept as a utility here because Drive.serializeConfig was its first caller.
 */
Drive.normalizeDates = function (data, tz) {
  return data.map(function (row) {
    return row.map(function (cell) {
      if (Object.prototype.toString.call(cell) === '[object Date]') {
        return Utilities.formatDate(cell, tz, 'yyyy-MM-dd');
      }
      return cell;
    });
  });
};

/**
 * Build the {fieldName: visible} map from 7_form data.
 * Public so Variant.gs can rebuild it from a filtered 7_form slice.
 */
Drive.buildFieldVisibilityMap = function (formData) {
  var map = {};
  for (var i = FORM_LAYOUT.DATA_START; i < formData.length; i++) {
    var fieldName = String(formData[i][FORM_LAYOUT.FIELD_COL] || '').trim();
    if (fieldName === '') continue;
    map[fieldName] = Util.coerceTruthy(formData[i][FORM_LAYOUT.VISIBLE_COL]);
  }
  return map;
};

/**
 * Build the {fieldName: supplierHidden} map from 4_fields data.
 *
 * Field property, NOT a per-variant setting: the value is read off the field's own row, so it is
 * identical wherever the field appears. Sibling to buildFieldVisibilityMap; emitted as _field_supplier_readonly.
 *
 * Blank / unrecognized cell -> false (field is editable). Existing fields with
 * no value in the new column therefore default to editable with no backfill.
 *
 * Public so Variant.gs can rebuild it from a filtered 4_fields slice.
 */
Drive.buildFieldHiddenMap = function (fieldsData) {
  var map = {};
  for (var i = FIELDS_LAYOUT.DATA_START; i < fieldsData.length; i++) {
    var fieldName = String(fieldsData[i][FIELDS_LAYOUT.FIELD_NAME_COL] || '').trim();
    if (fieldName === '') continue;
    map[fieldName] = Util.coerceTruthy(fieldsData[i][FIELDS_LAYOUT.SUPPLIER_HIDDEN_COL]);
  }
  return map;
};

/**
 * Trash JSON files in `folder` whose names start with any of the given prefixes. Single folder pass
 * regardless of prefix count. Non-fatal: logs and continues on individual file failures.
 *
 * Public so Variant.gs can apply the same cleanup rule to variant files.
 */
Drive.cleanupOldFiles = function (folder, prefixes) {
  if (!prefixes || prefixes.length === 0) return;

  try {
    var files = folder.getFilesByType('application/json');
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      for (var i = 0; i < prefixes.length; i++) {
        if (name.indexOf(prefixes[i]) === 0) {
          file.setTrashed(true);
          console.log('Trashed old config file: ' + name);
          break;
        }
      }
    }
  } catch (e) {
    console.warn('Config cleanup failed: ' + e.message);
  }
};


// --- Private utilities ------------------------------------------------
/**
 * Find or create the running user's scratch folder for validate/preview
 * artifacts. Lives at the user's Drive root; deterministic per user.
 * Every file created here is owned by the running user, so there are no
 * cross-user trash/ownership conflicts by construction.
 */
Drive._getOrCreateUserScratchFolder = function () {
  var name = 'SDC validate artifacts';
  var it = DriveApp.getRootFolder().getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
};
