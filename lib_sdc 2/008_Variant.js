/**
 * @file 008_Variant.gs
 * Per-variant JSON serialization. Slices the base config by inclusion
 * checkboxes in 6_variants (fields checked for variant N go into variant N's JSON).
 *
 * What's filtered, passed through, and omitted (per v1.0 decision):
 *   FILTERED to included fields:
 *     - 4_fields
 *     - _field_visibility (derived; entries for included fields only)
 *     - 7_form
 *   PASSED THROUGH unchanged:
 *     - 1_customer, 2_suppliers, 3_users
 *     - 5_lookups, 4_complex_validations
 *     - _error_translation, _mapping
 *   OMITTED:
 *     - 6_variants (self-referential)
 *
 * _meta extension: variant_name, variant_index (1-based).
 *
 * Cleanup rule (asymmetric, mirrors Drive.serializeConfig):
 *   - purpose='provision' → trashes ALL prior variant_{ssId}_* AND validate-variant_{ssId}_* for this workbook.
 *   - purpose='validate'  → trashes nothing.
 *
 * Public:
 *   Variant.serializeAll(ss, config, options) → { fileIds, variantsGenerated, names }
 */

var Variant = {};

var FILE_PREFIX_VARIANT          = 'variant_';
var FILE_PREFIX_VALIDATE_VARIANT = 'validate-variant_';

/**
 * Serialize one JSON file per variant defined in 1_customer!D6 / 6_variants.
 * Returns empty result when variant count is 0 or blank.
 *
 * Each file is shared with the Workato OAuth account before this function returns; failure to share is fatal. 
 * Returned fileIds map 1:1 to variant_index (i.e. fileIds[0] is Variant_1).
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config
 * @param {Object}      options
 * @param {string}      options.purpose                 - 'provision' | 'validate'
 * @param {string}      options.integrationAccountEmail - For per-file share
 * @param {Object}      [options.baseOutput]            - The output from Drive.serializeConfig. When provided, skips re-reading connector 
 *                                                        sheets; the variant slices are derived from baseOutput's already-normalized data.
 * @returns {{fileIds: string[], variantsGenerated: number, names: string[]}}
 */
Variant.serializeAll = function(ss, config, options) {
  if (!ss)      throw new Error('Variant.serializeAll: ss is required.');
  if (!config)  throw new Error('Variant.serializeAll: config is required.');
  if (!options) throw new Error('Variant.serializeAll: options is required.');

  var purpose                 = options.purpose;
  var integrationAccountEmail = options.integrationAccountEmail;
  var baseOutput              = options.baseOutput || null;

  if (purpose !== 'provision' && purpose !== 'validate') {
    throw new Error('Variant.serializeAll: purpose must be "provision" or "validate".');
  }
  if (!integrationAccountEmail) {
    throw new Error('Variant.serializeAll: options.integrationAccountEmail is required.');
  }

  var variantCount = Variant._readVariantCount(ss, config);
  if (variantCount <= 0) {
    return { fileIds: [], variantsGenerated: 0, names: [] };
  }

  // Source the per-sheet data: prefer baseOutput when present (no re-read).
  var baseSheets = baseOutput
    ? Variant._sheetsFromBaseOutput(baseOutput)
    : Variant._readBaseSheets(ss);

  // 6_variants is omitted from variant JSONs but we still need its data
  // here to compute inclusion. baseOutput contains it; otherwise read it.
  var variantsData = baseSheets['6_variants'];
  if (!variantsData) {
    var variantsSheet = ss.getSheetByName(config.sheets.variants);
    if (!variantsSheet) {
      throw new Error(
        'Sheet "' + config.sheets.variants + '" not found. ' +
        'Cannot serialize variants without the variants matrix.'
      );
    }
    variantsData = variantsSheet.getDataRange().getValues();
  }

  var folder = Drive.resolveDestinationFolder(ss, config, { purpose: purpose });

  // Cleanup before any writes (asymmetric per workflow rule).
  if (purpose === 'provision') {
    var ssId = ss.getId();
    Drive.cleanupOldFiles(folder, [
      FILE_PREFIX_VARIANT          + ssId + '_',
      FILE_PREFIX_VALIDATE_VARIANT + ssId + '_'
    ]);
  }

  var fileIds = [];
  var names   = [];

  for (var variantIndex = 1; variantIndex <= variantCount; variantIndex++) {
    var variantName    = 'Variant_' + variantIndex;
    var includedFields = Variant._extractIncludedFields(variantsData, variantIndex);

    var variantOutput = Variant._buildVariantEnvelope(
      baseSheets, includedFields, config.schemaVersion, ss.getId(),
      purpose, variantName, variantIndex
    );

    var fileId = Variant._writeVariantFile(folder, ss.getId(), variantName, purpose, variantOutput);
    Drive.shareWithIntegrationAccount(fileId, integrationAccountEmail);

    fileIds.push(fileId);
    names.push(variantName);
  }

  return {
    fileIds:           fileIds,
    variantsGenerated: variantCount,
    names:             names
  };
};

// --- Private helpers -------------------------------------------------
/**
 * Read variant count via the CUSTOMER_FIELDS registry (schema 1.4+): named range cfg_variant_count, with the label as fallback. Replaces the
 * direct label read, so the variant count now survives label edits like every other 1_customer field. Blank / missing / negative -> 0
 * (variantCount = 0 is a legitimate state).
 */
Variant._readVariantCount = function(ss, config) {
  var n = Customer.readOne(ss, config, 'variantCount');   // int | null
  return (n === null || n < 0) ? 0 : n;
};

/**
 * Extract per-sheet data from a Drive.serializeConfig baseOutput. Filters out the envelope metadata keys (_meta, _field_visibility)
 * so the result is the same shape as Variant._readBaseSheets.
 *
 * Convention: any future top-level envelope key with leading underscore will also be stripped here. If a future schema adds a non-underscore
 *             envelope key (unlikely), this filter would need to be made an explicit allowlist instead.
 */
Variant._sheetsFromBaseOutput = function(baseOutput) {
  var sheets = {};
  for (var key in baseOutput) {
    if (!Object.prototype.hasOwnProperty.call(baseOutput, key)) continue;
    if (key.charAt(0) === '_') continue;  // _meta, _field_visibility
    sheets[key] = baseOutput[key];
  }
  return sheets;
};

/**
 * Fallback path: read every connector sheet directly. Used when baseOutput is not provided (i.e. Variant.serializeAll called
 * outside an orchestrator that already serialized the base).
 */
Variant._readBaseSheets = function(ss) {
  var tz   = ss.getSpreadsheetTimeZone();
  var data = {};

  for (var i = 0; i < CONNECTOR_SHEETS_ORDER.length; i++) {
    var name  = CONNECTOR_SHEETS_ORDER[i];
    var sheet = ss.getSheetByName(name);
    if (!sheet) continue;
    data[name] = Drive.normalizeDates(sheet.getDataRange().getValues(), tz);
  }
  return data;
};

/**
 * Walk 6_variants data and collect field names whose inclusion column
 * for variant N is truthy. variantIndex is 1-based.
 *
 * Returns a Set for O(1) membership checks during filtering.
 */
Variant._extractIncludedFields = function(variantsData, variantIndex) {
  var included    = new Set();
  var variantCol  = VARIANT_LAYOUT.VARIANT_COL_START + (variantIndex - 1);

  for (var i = VARIANT_LAYOUT.DATA_START; i < variantsData.length; i++) {
    var row = variantsData[i];
    if (variantCol >= row.length) continue;

    var fieldName = String(row[VARIANT_LAYOUT.FIELD_NAME_COL] || '').trim();
    if (fieldName === '') continue;

    if (Util.coerceTruthy(row[variantCol])) {
      included.add(fieldName);
    }
  }
  return included;
};

/**
 * Build the variant JSON envelope: filter the field-scoped sheets,
 * pass everything else through, omit 6_variants, attach extended _meta.
 */
Variant._buildVariantEnvelope = function(baseSheets, includedFields, schemaVersion,
                                         workbookId, purpose, variantName, variantIndex) {
  var output = {};

  for (var i = 0; i < CONNECTOR_SHEETS_ORDER.length; i++) {
    var name = CONNECTOR_SHEETS_ORDER[i];
    var data = baseSheets[name];
    if (!data) continue;

    if (name === '6_variants') {
      continue;  // omitted by design
    }

    if (name === '4_fields') {
      output[name] = Variant._filter4Fields(data, includedFields);
    } else if (name === '7_form') {
      output[name] = Variant._filter7Form(data, includedFields);
    } else {
      output[name] = data;  // passthrough
    }
  }

  // Filtered _field_visibility derived from filtered 7_form.
  if (output['7_form']) {
    output['_field_visibility'] = Drive.buildFieldVisibilityMap(output['7_form']);
  }

  // Filtered _field_supplier_readonly derived from filtered 4_fields.
  if (output['4_fields']) {
    output['_field_supplier_hidden'] = Drive.buildFieldHiddenMap(output['4_fields']);
  }

  output['_meta'] = {
    schema_version:  schemaVersion,
    library_version: SDC_LIBRARY_VERSION,
    payload_version: SDC_PAYLOAD_VERSION,
    purpose:         purpose,
    workbook_id:     workbookId,
    serialized_at:   new Date().toISOString(),
    variant_name:    variantName,
    variant_index:   variantIndex
  };

  return output;
};

/**
 * Filter 4_fields rows to those whose field name is in includedFields.
 * Header rows (everything before the data-start row) pass through unchanged.
 *
 * 0-indexed DATA_START_ROW = 8 corresponds to row 9 in the workbook,
 * verified against the v0.9.7 master config (B9 = 'Employee name').
 * Field name is in column C (index 2) per the same workbook layout.
 *
 * Magic numbers will move to a Schema.gs constant when the
 * PRIMARY_KEY_COLUMNS reconciliation lands.
 */
Variant._filter4Fields = function(data, includedFields) {
  var filtered = [];

  for (var i = 0; i < FIELDS_LAYOUT.DATA_START && i < data.length; i++) {
    filtered.push(data[i]);
  }

  // Filter rows
  for (var j = FIELDS_LAYOUT.DATA_START; j < data.length; j++) {
    var fieldName = String(data[j][FIELDS_LAYOUT.FIELD_NAME_COL] || '').trim();
    if (fieldName === '' || includedFields.has(fieldName)) {
      filtered.push(data[j]);
    }
  }

  return filtered;
};

/**
 * Filter 7_form rows to those whose field name is in includedFields.
 * Header rows pass through.
 *
 * Field name is in column B (FIELD_COL = 1) per FORM_LAYOUT.
 */
Variant._filter7Form = function(data, includedFields) {
  var filtered = [];

  for (var i = 0; i < FORM_LAYOUT.DATA_START && i < data.length; i++) {
    filtered.push(data[i]);
  }

  for (var j = FORM_LAYOUT.DATA_START; j < data.length; j++) {
    var fieldName = String(data[j][FORM_LAYOUT.FIELD_COL] || '').trim();
    if (fieldName === '' || includedFields.has(fieldName)) {
      filtered.push(data[j]);
    }
  }
  return filtered;
};

Variant._writeVariantFile = function(folder, ssId, variantName, purpose, output) {
  var prefix   = (purpose === 'validate' ? FILE_PREFIX_VALIDATE_VARIANT : FILE_PREFIX_VARIANT)
               + ssId + '_' + variantName + '_';
  var stamp    = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  var fileName = prefix + stamp + '.json';
  var blob     = Utilities.newBlob(JSON.stringify(output), 'application/json', fileName);
  return folder.createFile(blob).getId();
};