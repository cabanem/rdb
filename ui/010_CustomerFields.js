/**
 * CustomerFields — the shape of 1_customer, as the web app sees it.
 *
 * The source of truth is lib_sdc's CUSTOMER_FIELDS registry (003_Schema.js,
 * schema 1.4+): one entry per 1_customer value, keyed by a workbook-scoped
 * named range. This module does NOT redefine that registry. It reads it from
 * the library (identifier `SDC`) and projects it into something a form can
 * render. The fixture below exists only so the app can be exercised in an
 * Apps Script project that has not yet added the library — see FIXTURE_NOTE.
 */
var CustomerFields = (function () {

  // Grouping is presentation. The library registry has no notion of groups,
  // so the app owns this map. Unknown keys fall into 'Other'.
  var GROUPS = [
    { id: 'engagement', title: 'Engagement',
      keys: ['clientName', 'applicationName', 'analystEmail', 'targetVms', 'outputDriveFolderId'] },
    { id: 'timeline',   title: 'Timeline and reminders',
      keys: ['expectedDate', 'reminderDays'] },
    { id: 'messaging',  title: 'Supplier messaging',
      keys: ['kickoffEmailBody', 'supplierInstructions'] },
    { id: 'seed',       title: 'Seed data',
      keys: ['hasSeedData', 'seedDataDriveId', 'seedDataSheetName', 'seedDataIndexKey',
             'seedDataHeaderRow', 'seedDataFirstDataRow'] },
    { id: 'template',   title: 'Template',
      keys: ['variantCount'] }
  ];

  // Registry type → HTML input. 'intList' stays a text input: the sheet cell
  // holds "7, 14, 21" and lib_sdc parses it; the app must not pre-parse.
  var INPUT_FOR_TYPE = { string: 'text', int: 'number', intList: 'text', date: 'date', bool: 'checkbox' };
  var MULTILINE_KEYS = { kickoffEmailBody: 1, supplierInstructions: 1 };

  /**
   * FIXTURE_NOTE — read before trusting these rows.
   * Reconstructed from the schema-1.4 registry as cut in July 2026, plus the
   * two seed-row fields added in lib_sdc 1.7.0. Honest gaps:
   *   - the 1.4 registry had 15 entries; one (between outputDriveFolderId and
   *     reminderDays) could not be recovered and is absent here;
   *   - the rangeName for the two 1.7.0 fields is a guess at the naming pattern;
   *   - `required` flags are as of 1.4 and may have moved since.
   * None of this matters in live mode: the fixture is bypassed entirely.
   */
  var FIXTURE = [
    { key: 'clientName',           rangeName: 'cfg_customer_name',          friendly: 'Customer name',            type: 'string',  required: true  },
    { key: 'analystEmail',         rangeName: 'cfg_analyst_email',          friendly: 'Analyst email address',    type: 'string',  required: true  },
    { key: 'applicationName',      rangeName: 'cfg_application_name',       friendly: 'Application name',         type: 'string',  required: true  },
    { key: 'targetVms',            rangeName: 'cfg_target_vms',             friendly: 'Target VMS',               type: 'string',  required: false },
    { key: 'outputDriveFolderId',  rangeName: 'cfg_output_folder_id',       friendly: 'Drive folder ID',          type: 'string',  required: true  },
    { key: 'reminderDays',         rangeName: 'cfg_reminder_days',          friendly: 'Reminder cadence',         type: 'intList', required: true  },
    { key: 'supplierInstructions', rangeName: 'cfg_supplier_instructions',  friendly: 'Portal instructions',      type: 'string',  required: false },
    { key: 'kickoffEmailBody',     rangeName: 'cfg_kickoff_email_body',     friendly: 'Kick off email instructions', type: 'string', required: true },
    { key: 'hasSeedData',          rangeName: 'cfg_has_seed_data',          friendly: 'Incumbent data flag',      type: 'bool',    required: false },
    { key: 'seedDataDriveId',      rangeName: 'cfg_seed_data_drive_id',     friendly: 'Seed data Drive file ID',  type: 'string',  required: false },
    { key: 'seedDataSheetName',    rangeName: 'cfg_seed_data_sheet_name',   friendly: 'Seed data sheet name',     type: 'string',  required: false },
    { key: 'seedDataIndexKey',     rangeName: 'cfg_seed_data_index_key',    friendly: 'Seed data index key',      type: 'string',  required: false },
    { key: 'seedDataHeaderRow',    rangeName: 'cfg_seed_data_header_row',   friendly: 'Seed data header row',     type: 'int',     required: false },
    { key: 'seedDataFirstDataRow', rangeName: 'cfg_seed_data_first_data_row', friendly: 'Seed data first data row', type: 'int',   required: false },
    { key: 'expectedDate',         rangeName: 'cfg_expected_date',          friendly: 'Last day for data submission', type: 'date', required: true },
    { key: 'variantCount',         rangeName: 'cfg_variant_count',          friendly: 'Variant count',            type: 'int',     required: false }
  ];

  /** The raw registry, and where it came from. */
  function registry() {
    if (typeof SDC !== 'undefined') {
      // Preferred: an explicit accessor in the library (add `function getCustomerFields(){return CUSTOMER_FIELDS;}`
      // to 003_Schema.js). Fallback: the exposed global, which libraries do publish.
      if (typeof SDC.getCustomerFields === 'function') return { source: 'lib_sdc:getCustomerFields', fields: SDC.getCustomerFields() };
      if (SDC.CUSTOMER_FIELDS)                          return { source: 'lib_sdc:CUSTOMER_FIELDS',   fields: SDC.CUSTOMER_FIELDS };
    }
    return { source: 'fixture (see FIXTURE_NOTE)', fields: FIXTURE };
  }

  /** Form schema: groups of fields, each carrying what the renderer and the writer need. */
  function formSchema() {
    var reg = registry();
    var byKey = {};
    reg.fields.forEach(function (d) { byKey[d.key] = d; });

    var placed = {};
    var groups = GROUPS.map(function (g) {
      var fields = g.keys.filter(function (k) { return byKey[k]; }).map(function (k) { placed[k] = 1; return toFormField(byKey[k]); });
      return { id: g.id, title: g.title, fields: fields };
    }).filter(function (g) { return g.fields.length; });

    var leftovers = reg.fields.filter(function (d) { return !placed[d.key]; }).map(toFormField);
    if (leftovers.length) groups.push({ id: 'other', title: 'Other', fields: leftovers });

    return { source: reg.source, fieldCount: reg.fields.length, groups: groups };
  }

  function toFormField(d) {
    return {
      key: d.key,
      rangeName: d.rangeName,
      label: d.friendly || d.key,
      type: d.type,
      input: MULTILINE_KEYS[d.key] ? 'textarea' : (INPUT_FOR_TYPE[d.type] || 'text'),
      required: !!d.required,
      hint: hintFor(d)
    };
  }

  function hintFor(d) {
    if (d.type === 'intList') return 'Comma-separated day offsets, e.g. 7, 14, 21';
    if (d.type === 'date')    return 'Written to the sheet as a date value';
    if (d.key === 'outputDriveFolderId') return 'Where generated supplier templates are saved';
    return '';
  }

  /** Validate a submitted form against the registry: required-ness and basic type shape. */
  function validate(values) {
    var problems = [];
    registry().fields.forEach(function (d) {
      var v = values[d.key];
      var blank = v === undefined || v === null || String(v).trim() === '';
      if (d.required && blank) { problems.push(d.friendly + ' is required'); return; }
      if (blank) return;
      if (d.type === 'int'     && !/^\d+$/.test(String(v).trim()))             problems.push(d.friendly + ' must be a whole number');
      if (d.type === 'intList' && !/^\d+(\s*,\s*\d+)*$/.test(String(v).trim())) problems.push(d.friendly + ' must be numbers separated by commas');
      if (d.type === 'date'    && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))      problems.push(d.friendly + ' must be a date');
    });
    return problems;
  }

  return { registry: registry, formSchema: formSchema, validate: validate };
})();
