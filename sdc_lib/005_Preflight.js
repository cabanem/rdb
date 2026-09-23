/**
 * @file 005_Preflight.gs
 * Common pre-execution checks for any flow that serializes config and hands it to Workato.
 *
 * Public:
 *   Preflight.run(ss, config, options) → { customerSheet, integrationAccountEmail, [clientName, analystEmail, targetVms, separateWorkspace] }
 *
 * Throw-on-failure contract: every check raises a user-facing Error on the first failure. Orchestrators wrap
 * the call in a single try/catch and own UI/logging.
 *
 * Checks (in order):
 *   1. Schema sanity — already enforced by Config.build; preflight does not re-check.
 *   2. All CONNECTOR_SHEETS present in the workbook.
 *   2b. Sheet layouts match the library's layout constants and PK columns (Layout.verify, schema 1.7+).
 *   3. The customer sheet (per config.sheets.customer) is present.
 *   4. The supplied webhook URL is non-empty.
 *   5. config.sharing.integrationAccountEmail is present and email-shaped.
 *   6. (Optional) Customer name and analyst email populated in 1_customer.
 */

var Preflight = {};

/**
 * @param {Spreadsheet} ss
 * @param {Object}      config
 * @param {Object}      options
 * @param {string}      options.webhookUrl                  - The URL to validate (caller resolves from config.webhook.* and passes in).
 * @param {string}      options.webhookLabel                - The _developer_settings key for error messages (e.g. 'fileExportUrl').
 * @param {boolean}     [options.requireCustomerData=false] - When true, also pull and validate customer fields from 1_customer.
 * @returns {Object} { customerSheet, integrationAccountEmail, [clientName, analystEmail, targetVms, separateWorkspace] }
 * @throws  Error with a user-facing message on any check failure.
 */
Preflight.run = function (ss, config, options) {
  if (!ss) throw new Error('Preflight.run: ss is required.');
  if (!config) throw new Error('Preflight.run: config is required.');
  if (!options) throw new Error('Preflight.run: options is required.');

  // 1. All connector sheets present
  var missing = [];
  CONNECTOR_SHEETS_ORDER.forEach(function (name) {
    if (!ss.getSheetByName(name)) missing.push(name);
  });
  if (missing.length > 0) {
    throw new Error(
      'Missing required sheets: ' + missing.join(', ') + '. ' +
      'These sheets are part of the workbook schema (v' + config.schemaVersion + ') ' +
      'and must be present for the SDC platform to read the configuration.'
    );
  }

  // 1b. Sheet layouts match the library's constants (header anchors + PK columns). Every reader in Drive, Variant and
  //     PrimaryKey addresses columns by fixed index, so a shifted column must fail here, by name, rather than serialize
  //     the wrong cells. A stray PK column on a cast sheet is the schema-1.7 migration's job, and the message says so.
  var layout = Layout.verify(ss);
  if (!layout.ok) {
    throw new Error(
      'Workbook layout does not match schema v' + SDC_SCHEMA_VERSION + ':\n  - ' + layout.problems.join('\n  - ') +
      '\nIf the workbook has not been migrated, run "Migrate workbook schema" from the menu and retry. ' +
      'Otherwise a header cell was edited or a column was moved; restore it to the text shown.'
    );
  }

  // 2. Customer sheet present (defensive — already covered by check 1, but the error message here is more specific to the customer-data flow.)
  var customerSheet = ss.getSheetByName(config.sheets.customer);
  if (!customerSheet) {
    throw new Error(
      'Sheet "' + config.sheets.customer + '" not found. ' +
      'This is the workbook\'s customer-information tab; check that it has not been ' +
      'renamed and that _developer_settings → sheets.customer matches.'
    );
  }

  // 3. Webhook URL configured
  if (!options.webhookUrl) {
    throw new Error(
      'Webhook URL not configured. ' +
      'Check _developer_settings → webhook.' + options.webhookLabel + '.'
    );
  }

  // 4. Workato OAuth account email present and well-formed
  var integrationAccountEmail = config.sharing.integrationAccountEmail;
  if (!integrationAccountEmail || !Util.isValidEmailShape(integrationAccountEmail)) {
    throw new Error(
      'Workato OAuth account email is missing or malformed. ' +
      'Check _developer_settings → sharing.integrationAccountEmail. ' +
      'Workato cannot read the config file without this share.'
    );
  }

  // 5. Customer data fields (provision path only). Reads go through Customer.read (named ranges with label fallback + self-heal).
  // Required-ness and coercion are driven by the CUSTOMER_FIELDS registry.
  var customerData = {};
  if (options.requireCustomerData) {
    var read = Customer.read(ss, config);
    customerData = read.values;

    var defsByKey = {};
    CUSTOMER_FIELDS.forEach(function (d) { defsByKey[d.key] = d; });

    // 5a. Fields that could not be LOCATED at all (named range AND label both missing). Distinct from "located but blank".
    var lost = read.unresolved.filter(function (u) { return defsByKey[u.key].required; });
    if (lost.length > 0) {
      throw new Error(
        'Could not locate these fields on the ' + config.sheets.customer + ' tab: ' +
        lost.map(function (u) { return '"' + u.label + '"'; }).join(', ') + '. ' +
        'Each field is read through a workbook named range (' +
        lost.map(function (u) { return u.rangeName; }).join(', ') + ') with the printed ' +
        'question text as a fallback; neither was found. This usually means the ' +
        'question wording was edited and the named range was also removed. Restore ' +
        'the wording, or recreate the named range via Data \u2192 Named ranges, then retry.'
      );
    }

    // 5b. Required-but-blank (registry-driven)
    var missingFields = [];
    CUSTOMER_FIELDS.forEach(function (def) {
      if (!def.required) return;
      var v = customerData[def.key];
      var blank;
      switch (def.type) {
        case 'intList':
          blank = v.ints.length === 0 && v.invalid.length === 0;
          break;
        case 'date': {
          var rd = read.raw[def.key];
          blank = rd === null || rd === undefined || rd === '';
          break;
        }
        case 'bool':
          blank = false;  // booleans coerce blank -> false; never "missing"
          break;
        default:
          blank = v === null;
      }
      if (blank) missingFields.push(def.friendly);
    });
    if (missingFields.length > 0) {
      throw new Error(
        'Required customer fields missing in the ' + config.sheets.customer + ' tab: ' +
        missingFields.join(', ') + '. ' +
        'All required fields must be filled in before the configuration can be sent to Workato.'
      );
    }

    // 5c. Expected date (present but not a usable date).
    var rawExpectedDate = read.raw.expectedDate;
    var rawDateBlank = rawExpectedDate === null || rawExpectedDate === undefined || rawExpectedDate === '';
    if (!rawDateBlank && customerData.expectedDate === null) {
      throw new Error(
        'The "' + Labels.expectedDate + '" value in the ' + config.sheets.customer +
        ' tab is not a recognizable date. Enter it via the date picker (yyyy-mm-dd). ' +
        'Text in another format, or a number formatted to look like a date, cannot be used.'
      );
    }

    // 5d. Last day for submission (shape validation)
    var rawLastDay = read.raw.lastDayForSubmission;
    var rawLastDayBlank = rawLastDay === null || rawLastDay === undefined || rawLastDay === '';
    if (!rawLastDayBlank && customerData.lastDayForSubmission === null) {
      throw new Error(
        'The "' + Labels.lastDayForSubmission + '" value in the ' + config.sheets.customer +
        ' tab is not a recognizable date. Enter it via the date picker (yyyy-mm-dd). ' +
        'Text in another format, or a number formatted to look like a date, cannot be used.'
      );
    }

    // 5e. Reminder cadence (reject bad tokens, then flatten to the int array that Payload.provision ships as reminder_days).
    var cadence = customerData.reminderDays;   // { ints, invalid } from parseIntList
    if (cadence.invalid.length > 0) {
      throw new Error(
        'The "' + Labels.reminderDays + '" value contains entries that are not ' +
        'positive whole numbers: ' + cadence.invalid.join(', ') + '. ' +
        'Enter a comma-separated list of day counts, e.g. "7, 14, 21".'
      );
    }
    customerData.reminderDays = cadence.ints;
    // Optional — enable if semantics stay "offsets from the initial request":
    // for (var d = 1; d < customerData.reminderDays.length; d++) {
    //   if (customerData.reminderDays[d] <= customerData.reminderDays[d - 1]) {
    //     throw new Error('Reminder days must be strictly increasing offsets from ' +
    //                     'the initial request; got: ' + cadence.ints.join(', ') + '.');
    //   }
    // }

    // 5f. Seed data (required only when the analyst declared it). The index key is required too: INC-01 declares
    //     index_key non-optional, so a blank here would only fail later, inside Workato.
    if (Util.coerceTruthy(customerData.hasSeedData)) {
      var seedMissing = [];
      if (!String(customerData.seedDataDriveId || '').trim()) seedMissing.push('Seed data Drive file ID');
      if (!String(customerData.seedDataSheetName || '').trim()) seedMissing.push('Seed data sheet name');
      if (!String(customerData.seedDataIndexKey || '').trim()) seedMissing.push('Seed data index key');
      if (seedMissing.length > 0) {
        throw new Error(
          'Incumbent data was marked as provided ("' + Labels.hasSeedData + '" = yes), ' +
          'but these required seed-data fields are missing in the ' + config.sheets.customer +
          ' tab: ' + seedMissing.join(', ') + '. ' +
          'Either provide these values or set the incumbent-data question to no.'
        );
      }

      // 5g. Seed row geometry. 1-based Excel rows as the analyst reads them; blank means "plain file":
      //     header on row 1, data from row 2. Otherwise header >= 1 and first data row after the header.
      //     A non-blank cell that did not coerce to an integer is a typo, not a blank.
      var rawHdr = read.raw.seedDataHeaderRow;
      var rawFirst = read.raw.seedDataFirstDataRow;
      var hdrBlank = rawHdr === null || rawHdr === undefined || rawHdr === '';
      var firstBlank = rawFirst === null || rawFirst === undefined || rawFirst === '';
      if (!hdrBlank && customerData.seedDataHeaderRow === null) {
        throw new Error('The "' + Labels.seedDataHeaderRow + '" value must be a whole number (Excel row number); got "' + rawHdr + '".');
      }
      if (!firstBlank && customerData.seedDataFirstDataRow === null) {
        throw new Error('The "' + Labels.seedDataFirstDataRow + '" value must be a whole number (Excel row number); got "' + rawFirst + '".');
      }
      var hdr = hdrBlank ? 1 : customerData.seedDataHeaderRow;
      var first = firstBlank ? hdr + 1 : customerData.seedDataFirstDataRow;
      if (hdr < 1) {
        throw new Error('The "' + Labels.seedDataHeaderRow + '" value must be 1 or greater; got ' + hdr + '.');
      }
      if (first <= hdr) {
        throw new Error('The "' + Labels.seedDataFirstDataRow + '" value (' + first + ') must be below the header row (' + hdr + ').');
      }
      customerData.seedDataHeaderRow = hdr;
      customerData.seedDataFirstDataRow = first;
    }
  }

  return Object.assign({
    customerSheet: customerSheet,
    integrationAccountEmail: integrationAccountEmail
  }, customerData);
};
