/**
 * @file 003_Payload.gs
 * Webhook payload builders. One builder per webhook contract.
 *
 * Builders own the wire format (snake_case) and the field-name contract.
 * Callers pass JS-idiomatic camelCase args; builders translate.
 *
 * payload_version is NOT stamped here - Webhook.call owns that invariant.
 *
 * Public:
 *   Payload.provision(args)    -> object
 *   Payload.validate(args)     -> object
 *   Payload.portalInvite(args) -> object
 *
 * Each builder validates its required args and throws on missing/blank.
 * Optional fields are normalized.
 */

var Payload = {};

// --- Provision -------------------------------------------------------

/**
 * Build the provision webhook payload (R-1 Receive Webhook contract).
 *
 * Wire-format changes in payload_version 2.0:
 *   - config_json_file_id renamed to drive_id_config_json
 *   - is_initial added (boolean; menu-derived: "Start supplier data
 *     collection" -> true, "Update configuration" -> false)
 *
 * Wire-format changes in payload_version 10.0:
 *   - seeded_data_header_row, seeded_data_first_data_row added (integer | null; from 1_customer via Preflight).
 *     Null when has_seeded_data is false. INC-01/INC-02 position their seed readers on these rows.
 *
 * Wire-format changes in payload_version 3.0:
 *   - output_drive_folder_id added (string; from 1_customer).
 *     Distinct from config_file_id (the workbook) and from storage.configExportFolderId (where the library writes config JSON).
 *     This is Workato's output destination.
 *   - reminder_days_1, reminder_days_2, reminder_days_3 added (integers; from 1_customer). Cadence for non-compliant supplier reminders.
 *
 * @param {Object}  args
 * @param {string}  args.correlationId              - UUID linking the request across systems.
 * @param {string}  args.clientName                 - From 1_customer.
 * @param {string}  args.analystEmail               - From 1_customer.
 * @param {string}  args.expectedDate               - From 1_customer via Preflight, yyyy-MM-dd, date-only, workbook tz rendering.
 * @param {string}  args.configFileId               - The workbook's own Drive file ID (ss.getId()).
 * @param {string}  args.configJsonFileId           - The serialized JSON's Drive file ID. Wire field: drive_id_config_json.
 * @param {boolean} args.isInitial                  - True for initial provision runs; false for update runs. Menu-derived.
 * @param {string}  args.outputDriveFolderId        - From 1_customer. Drive folder where Workato writes outputs.
 * @param {number}  args.reminderDays               - From 1_customer. Days to first reminder.
 * @param {string}  args.supplierInstructions       - Instructions for the supplier portal. Scoped per workspace in v1.
 * @param {string}  args.kickoffEmailBody           - Email body
 * @parma {string}  args.lastDayForSubmission
 * @param {boolean} args.hasSeedData
 * @param {string}  args.seedDataDriveId
 * @param {string}  args.seedDataIndexKey
 * @param {string}  args.seedDataSheetName
 * @param {number}  [args.seedDataHeaderRow]    - 1-based Excel row of the seed sheet's header. Defaulted by Preflight when seeded.
 * @param {number}  [args.seedDataFirstDataRow] - 1-based Excel row of the first seed data row. Defaulted by Preflight when seeded.
 * @param {string}  args.seedDataXlsxFileId
 * @param {string}  [args.targetVms='']
 * @param {Array}   [args.templateFileIds=[]]       - Drive file IDs of per-variant
 * @returns {Object} wire-format payload
 */
Payload.provision = function (args) {
  Payload._requireArgs(args,
    ['correlationId', 'clientName', 'analystEmail', 'applicationName', 'configFileId', 'expectedDate',
      'configJsonFileId', 'configFingerprint', 'isInitial', 'outputDriveFolderId', 'lastDayForSubmission',
      'reminderDays', 'hasSeedData', 'spreadsheetId'], 'provision');

  return {
    correlation_id: args.correlationId,
    client_name: args.clientName,
    analyst_email: args.analystEmail,
    expected_date: args.expectedDate,
    last_day_for_submission: args.lastDayForSubmission,
    target_vms: args.targetVms || '',
    config_file_id: args.configFileId,
    drive_id_config_json: args.configJsonFileId,
    config_fingerprint: args.configFingerprint,
    template_file_ids: args.templateFileIds || [],
    application_name: args.applicationName,
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

// --- Validate --------------------------------------------------------
/**
 * Build the validate webhook payload.
 */
Payload.validate = function (args) {
  Payload._requireArgs(args, ['correlationId', 'configJsonFileId', 'requesterEmail', 'spreadsheetId'], 'validate');

  return {
    correlation_id: args.correlationId,
    config_json_file_id: args.configJsonFileId,
    requester_email: args.requesterEmail,
    timestamp: new Date().toISOString(),
    spreadsheet_id: args.spreadsheetId
  };
};

// --- Portal invite ---------------------------------------------------
/**
 * Build the portal invite webhook payload.
 */
Payload.portalInvite = function (args) {
  Payload._requireArgs(args, ['correlationId', 'userEmail', 'role', 'spreadsheetId'], 'portalInvite');

  return {
    correlation_id: args.correlationId,
    user_email: args.userEmail,
    contact_name: args.contactName || '',
    role: args.role,
    timestamp: new Date().toISOString(),
    spreadsheet_id: args.spreadsheetId
  };
};


// --- Invitations -----------------------------------------------------
/**
 * Build the invitations webhook payload (R1 — Issue Invitation).
 *
 * Wire format:
 *   batch_id                       — UUID; correlation across systems.
 *   analyst_email                  — The analyst initiating the batch.
 *   spreadsheet_id                 — The workbook's Google Sheets ID. Used for "latest batch for this workbook" queries downstream.
 *   exclude_supplier_request_ids   — Array of UUIDs to exclude from the invitable candidate list. May be empty (the "send to all invitable" case).
 *
 * @param {Object}        args
 * @param {string}        args.batchId                      - UUID.
 * @param {string}        args.analystEmail                 - The analyst initiating.
 * @param {string}        args.spreadsheetId                - ss.getId().
 * @param {Array<string>} [args.excludeSupplierRequestIds]  - Optional; defaults to [].
 * @returns {Object} wire-format payload
 */
Payload.invitations = function (args) {
  Payload._requireArgs(args, ['batchId', 'analystEmail', 'spreadsheetId'], 'invitations');

  var excludeIds = Array.isArray(args.excludeSupplierRequestIds)
    ? args.excludeSupplierRequestIds
    : [];

  return {
    batch_id: args.batchId,
    analyst_email: args.analystEmail,
    spreadsheet_id: args.spreadsheetId,
    exclude_supplier_request_ids: excludeIds,
    timestamp: new Date().toISOString()
  };
};


// --- Preview ---------------------------------------------------------
Payload.preview = function (args) {
  Payload._requireArgs(args, ['correlationId', 'configJsonFileId', 'requesterEmail', 'spreadsheetId'], 'preview');

  return {
    correlation_id: args.correlationId,
    config_json_file_id: args.configJsonFileId,
    requester_email: args.requesterEmail,
    variant_id: args.variantId || '',
    timestamp: new Date().toISOString(),
    spreadsheet_id: args.spreadsheetId
  };
};
// --- Private ---------------------------------------------------------

/** Integer pass-through for optional numeric wire fields: null unless a finite integer was supplied. */
Payload._intOrNull = function (v) {
  return Number.isInteger(v) ? v : null;
};

/**
 * Validate that args is present and all named fields are non-empty.
 *
 * Treats boolean false as a valid value - it must, because is_initial legitimately carries `false` for update runs.
 * The check is "field is present and not null/undefined/blank-string," NOT "field is truthy."
 */
Payload._requireArgs = function (args, required, builderName) {
  if (!args) {
    throw new Error('Payload.' + builderName + ': args object is required.');
  }
  for (var i = 0; i < required.length; i++) {
    var k = required[i];
    var v = args[k];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      throw new Error('Payload.' + builderName + ': "' + k + '" is required and must be non-empty.');
    }
  }
};
