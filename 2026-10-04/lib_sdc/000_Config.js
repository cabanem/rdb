/**
 * @file 000_Config.gs (SDC library)
 * Reads _developer_settings → typed config object. Single entry: Config.build(ss).
 *
 * 1.9.0: the per-endpoint webhook.* URLs and webhook.apiPlatformToken are gone; router.baseUrl and
 * router.apiToken replace them (see 009_Webhook). Migration 1.7 → 1.8 adds the rows.
 *
 * Public:
 *   Config.build(ss) → Object
 */

// --- Library defaults (workbook can override via _developer_settings) ---
var DEFAULT_SHEETS = Object.freeze({
  customer:     '1_customer',
  suppliers:    '2_suppliers',
  users:        '3_users',
  fields:       '4_fields',
  validations:  '4_complex_validations',
  lookups:      '5_lookups',
  variants:     '6_variants',
  form_ui:      '7_form'
});

// --- Public namespace ---
var Config = {};

/**
 * Build a typed config object from a workbook's _developer_settings.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Object} normalized config
 * @throws  If _developer_settings is missing or schema is incompatible.
 */
Config.build = function(ss) {
  if (!ss) throw new Error('Config.build: spreadsheet argument is required.');

  var devSheet = ss.getSheetByName('_developer_settings');
  if (!devSheet) {
    throw new Error("'_developer_settings' tab is missing from the workbook.");
  }

  var devData = devSheet.getDataRange().getValues();
  var get = function(category, key, defaultValue) {
    if (defaultValue === undefined) defaultValue = null;
    var row = devData.find(function(r) { return r[1] === category && r[2] === key; });
    return row ? row[3] : defaultValue;
  };

  // Schema check — workbook declares what library version it was built for
  var workbookSchema = String(get('meta', 'schema_version', '1.0'));
  Config._assertSchemaCompatible(workbookSchema, SDC_SCHEMA_VERSION);

  return {
    schemaVersion: workbookSchema,
    sheets: {
      customer:    get('sheets', 'customer',       DEFAULT_SHEETS.customer),
      suppliers:   get('sheets', 'suppliers',      DEFAULT_SHEETS.suppliers),
      users:       get('sheets', 'supplier_users', DEFAULT_SHEETS.users),
      fields:      get('sheets', 'fields',         DEFAULT_SHEETS.fields),
      validations: get('sheets', 'validations',    DEFAULT_SHEETS.validations),
      lookups:     get('sheets', 'lookupTables',   DEFAULT_SHEETS.lookups),
      variants:    get('sheets', 'variants',       DEFAULT_SHEETS.variants),
      form_ui:     get('sheets', 'form',           DEFAULT_SHEETS.form_ui)
    },
    // Router (library 1.9.0+). Every workbook → Workato call goes to the SDC router, which resolves the client
    // workspace from this workbook's spreadsheet ID. Both values are written by the routing workbook when the
    // workbook is claimed; they are the same for every workbook. meta.workspace_key is traceability only — the
    // library never sends it, the router decides the target from the registry.
    router: {
      baseUrl:      Config._str(get('router', 'baseUrl', '')),
      apiToken:     Config._str(get('router', 'apiToken', '')),
      workspaceKey: Config._str(get('meta',   'workspace_key', ''))
    },
    sharing: {
      authorizedEditors:       Config._parseEmailList(get('sharing', 'authorizedEditors', '')),
      integrationAccountEmail: String(get('sharing', 'integrationAccountEmail', '') || '').trim()
    },
    storage: {
      configExportFolderId: get('storage', 'configExportFolderId'),
      packsFolderId:        get('storage', 'packsFolderId')
    },
    // Config assistant (012_Assist). Every row is optional at build time; Assist checks what it needs per call.
    assist: {
      gcpProjectId:    Config._str(get('assist', 'gcpProjectId', '')),
      gcpLocation:     Config._str(get('assist', 'gcpLocation', 'us-central1')) || 'us-central1',
      geminiModel:     Config._str(get('assist', 'geminiModel', 'gemini-2.5-flash')) || 'gemini-2.5-flash',
      corpusFolderId:  Config._str(get('assist', 'corpusFolderId', '')),
      templateSheetId: Config._str(get('assist', 'templateSheetId', '')),
      logSheetId:      Config._str(get('assist', 'logSheetId', '')),
      includeFindings: Util.coerceTruthy(get('assist', 'includeFindings', false))
    }
  };
};

Config._str = function(v) {
  return String(v === null || v === undefined ? '' : v).trim();
};

Config._parseEmailList = function(raw) {
  return String(raw || '').split(',').map(function(e) { return e.trim(); })
    .filter(function(e) { return e !== ''; });
};

Config._assertSchemaCompatible = function(workbookSchema, librarySchema) {
  var wMajor = parseInt(workbookSchema.split('.')[0], 10);
  var lMajor = parseInt(librarySchema.split('.')[0], 10);
  if (wMajor !== lMajor) {
    throw new Error(
      'Schema version mismatch: workbook declares v' + workbookSchema +
      ', library expects v' + librarySchema + '. ' +
      'Update _developer_settings → meta.schema_version, or pin a compatible library version.'
    );
  }
};
