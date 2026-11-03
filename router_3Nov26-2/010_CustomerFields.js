/**
 * CustomerFields — the 1_customer shape as the web app sees it.
 *
 * Source of truth: lib_sdc 003_Schema.js → CUSTOMER_FIELDS (17 entries, schema 1.8). The library exposes top-level
 * vars across the boundary (the shim already reads SDC.Version this way), so SDC.CUSTOMER_FIELDS resolves directly.
 * This file never redefines a field. It owns two presentation facts only: grouping and input kind.
 */
var CustomerFields = (function () {

  var GROUPS = [
    { id: 'engagement', title: 'Engagement',
      keys: ['clientName', 'applicationName', 'analystEmail', 'targetVms', 'outputDriveFolderId'] },
    { id: 'timeline',   title: 'Timeline and reminders',
      keys: ['lastDayForSubmission', 'expectedDate', 'reminderDays'] },
    { id: 'messaging',  title: 'Supplier messaging',
      keys: ['kickoffEmailBody', 'supplierInstructions'] },
    { id: 'seed',       title: 'Incumbent (seed) data',
      keys: ['hasSeedData', 'seedDataDriveId', 'seedDataSheetName', 'seedDataIndexKey', 'seedDataHeaderRow', 'seedDataFirstDataRow'] },
    { id: 'template',   title: 'Template',
      keys: ['variantCount'] }
  ];

  var INPUT_FOR_TYPE = { string: 'text', int: 'number', intList: 'text', date: 'date', bool: 'checkbox' };
  var MULTILINE = { kickoffEmailBody: 1, supplierInstructions: 1 };
  var HINTS = {
    reminderDays:         'Day offsets after the initial request, e.g. 7, 14, 21',
    outputDriveFolderId:  'Drive folder where generated supplier templates are saved',
    seedDataHeaderRow:    'Excel row of the header in the seed sheet; blank means row 1',
    seedDataFirstDataRow: 'Excel row of the first data row; blank means the row after the header',
    variantCount:         'Leave blank for a single template'
  };

  function registry() {
    if (typeof SDC === 'undefined' || !SDC.CUSTOMER_FIELDS) {
      throw new Error('lib_sdc is not attached as "SDC". Add it under Project settings → Libraries.');
    }
    return SDC.CUSTOMER_FIELDS;
  }

  /** Grouped form fields. Every registry entry appears exactly once; unknown keys land in "Other". */
  function formSchema() {
    var fields = registry(), byKey = {}, placed = {};
    fields.forEach(function (d) { byKey[d.key] = d; });

    var groups = GROUPS.map(function (g) {
      var fs = g.keys.filter(function (k) { return byKey[k]; }).map(function (k) { placed[k] = 1; return toForm(byKey[k]); });
      return { id: g.id, title: g.title, fields: fs };
    }).filter(function (g) { return g.fields.length; });

    var rest = fields.filter(function (d) { return !placed[d.key]; }).map(toForm);
    if (rest.length) groups.push({ id: 'other', title: 'Other', fields: rest });

    return { schemaVersion: SDC.Version.SCHEMA, libraryVersion: SDC.Version.LIBRARY, fieldCount: fields.length, groups: groups };
  }

  function toForm(d) {
    return {
      key: d.key, rangeName: d.rangeName, label: d.label, type: d.type, required: !!d.required,
      input: MULTILINE[d.key] ? 'textarea' : (INPUT_FOR_TYPE[d.type] || 'text'),
      hint: HINTS[d.key] || ''
    };
  }

  /**
   * The only check made before a workbook exists: required fields present. Everything else (date shape, cadence
   * tokens, seed geometry, 4_fields layout) is the library's business and runs through Preflight after the write.
   */
  function missingRequired(values) {
    return registry().filter(function (d) {
      if (!d.required) return false;
      var v = values[d.key];
      return v === undefined || v === null || String(v).trim() === '';
    }).map(function (d) { return d.friendly; });
  }

  return { registry: registry, formSchema: formSchema, missingRequired: missingRequired };
})();
