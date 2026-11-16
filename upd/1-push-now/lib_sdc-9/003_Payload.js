/**
 * @file 003_Payload.gs (SDC library)
 * Builders for the inner request bodies the workspace endpoints read. One function per flow. Each one checks the
 * arguments it needs, maps the library's camelCase names to the snake_case wire names, and returns a plain object.
 * Webhook.call wraps that object in the router envelope and stamps payload_version; nothing here may set that key.
 *
 * Why a separate file: the wire contract is the one thing the library and the Workato side must agree on, so every
 * key name lives in one place. A field that leaves the CUSTOMER_FIELDS registry leaves here in the same release, and
 * a field that is still required here but no longer produced by Preflight fails _requireArgs loudly, before any call.
 *
 * 1.11.0 NOTE - this file was REBUILT. The 1.10.0 archive carried a copy of 005_Preflight under this name, so the
 * Payload object did not exist and every flow threw at its Payload.* call. Payload.provision is reconstructed from the
 * 1.10.0 edit map (every key confirmed) plus the 12.0 changes. The other four builders are reconstructed from their
 * call sites and the contracts documented on those files; diff them against the last good copy in the repo (or the
 * trigger schemas of the receiving recipes) before pinning, in particular the Drive-file-ID key on validate/preview.
 *
 * Wire-format history is kept in 008_Version.js (payload version history).
 *
 * Public:
 *   Payload.provision(args)     -> body for /provision               (API-00)
 *   Payload.validate(args)      -> body for /validate_configuration
 *   Payload.preview(args)       -> body for /preview-template_file
 *   Payload.invitations(args)   -> body for /invitations              (R-1)
 *   Payload.portalInvite(args)  -> body for /portal-invite            (API-04)
 */

var Payload = {};

/**
 * Provision body (payload 12.2).
 *
 * Customer attributes are the eight implementation attributes from 1_customer, read and shaped by Preflight
 * (requireCustomerData: true), so by the time this runs: clientName / analystEmail are non-blank strings,
 * expectedDate is 'yyyy-MM-dd', reminderDays is a non-empty int array, targetVms is string|null, the logo is either a
 * Drive file (customerLogoFileId + customerLogoDriveUrl, Preflight 5d / Logo.resolve) or a legacy public URL (customerLogoUrl),
 * supplierManagerEmail is an address-shaped string (Preflight 5f) or null, variantCount has already been consumed
 * by Variant.serializeAll (it is not on the wire; template_file_ids is).
 *
 * @param {Object}   args
 * @param {string}   args.correlationId
 * @param {string}   args.clientName
 * @param {string}   args.analystEmail
 * @param {string}   args.expectedDate          - 'yyyy-MM-dd' (workbook timezone).
 * @param {number[]} args.reminderDays          - Analyst order preserved.
 * @param {string}   [args.targetVms='']
 * @param {string}   [args.customerLogoFileId='']   - Drive ID of the uploaded logo image, or '' (12.2).
 * @param {string}   [args.customerLogoDriveUrl=''] - Its Drive link (https://drive.google.com/file/d/<id>/view), or '' (12.2).
 * @param {string}   [args.customerLogoUrl='']      - DEPRECATED legacy public http(s) URL of the logo, or ''. Set only when the
 *                                                    workbook still holds a public link instead of an uploaded file.
 * @param {string}   [args.customerLogoMimeType=''] - 'image/png' | 'image/jpeg' for an uploaded logo, read from the file's bytes
 *                                                    by Logo.resolve; '' for a legacy public URL or no logo (12.3).
 * @param {string}   [args.supplierManagerEmail=''] - Client-side supplier manager's address, or ''. Shape-checked by Preflight 5f (12.1).
 * @param {string}   args.configFileId          - The workbook (Spreadsheet) ID.
 * @param {string}   args.configJsonFileId      - Drive ID of the serialized config JSON (Drive.serializeConfig).
 * @param {string}   args.configFingerprint     - SHA-256 hex from Drive.serializeConfig (_meta.config_fingerprint).
 * @param {string[]} [args.templateFileIds=[]]  - Drive IDs of the per-variant config JSONs (Variant.serializeAll).
 * @param {boolean}  args.isInitial
 * @param {string}   args.spreadsheetId
 * @returns {Object} wire body
 */
Payload.provision = function (args) {
  Payload._requireArgs(args,
    ['correlationId', 'clientName', 'analystEmail', 'expectedDate', 'reminderDays', 'configFileId',
      'configJsonFileId', 'configFingerprint', 'isInitial', 'spreadsheetId'], 'provision');
  if (!Array.isArray(args.reminderDays) || args.reminderDays.length === 0) {
    throw new Error('Payload.provision: reminderDays must be a non-empty array of positive integers ' +
      '(Preflight flattens the cadence before this is called).');
  }

  return {
    correlation_id:       args.correlationId,
    client_name:          args.clientName,
    analyst_email:        args.analystEmail,
    expected_date:        args.expectedDate,
    reminder_days:        args.reminderDays,
    target_vms:           args.targetVms || '',
    customer_logo_file_id:   args.customerLogoFileId || '',
    customer_logo_drive_url: args.customerLogoDriveUrl || '',
    customer_logo_url:       args.customerLogoUrl || '',
    customer_logo_mime_type: args.customerLogoMimeType || '',
    supplier_manager_email: args.supplierManagerEmail || '',
    config_file_id:       args.configFileId,
    drive_id_config_json: args.configJsonFileId,
    config_fingerprint:   args.configFingerprint,
    template_file_ids:    args.templateFileIds || [],
    is_initial:           Boolean(args.isInitial),
    timestamp:            new Date().toISOString(),
    spreadsheet_id:       args.spreadsheetId
  };
};

/**
 * Validate body (path /validate_configuration). Validation never reads 1_customer (Preflight runs with
 * requireCustomerData: false), so this is the config file plus tracing.
 *
 * @param {Object} args  { correlationId, configJsonFileId, requesterEmail, spreadsheetId }
 */
Payload.validate = function (args) {
  Payload._requireArgs(args, ['correlationId', 'configJsonFileId', 'requesterEmail', 'spreadsheetId'], 'validate');
  return {
    correlation_id:       args.correlationId,
    drive_id_config_json: args.configJsonFileId,
    requester_email:      args.requesterEmail,
    timestamp:            new Date().toISOString(),
    spreadsheet_id:       args.spreadsheetId
  };
};

/**
 * Preview body (path /preview-template_file). The validate body plus the variant to render ('' = base template).
 *
 * @param {Object} args  { correlationId, configJsonFileId, requesterEmail, [variantId=''], spreadsheetId }
 */
Payload.preview = function (args) {
  Payload._requireArgs(args, ['correlationId', 'configJsonFileId', 'requesterEmail', 'spreadsheetId'], 'preview');
  return {
    correlation_id:       args.correlationId,
    drive_id_config_json: args.configJsonFileId,
    requester_email:      args.requesterEmail,
    variant_id:           args.variantId || '',
    timestamp:            new Date().toISOString(),
    spreadsheet_id:       args.spreadsheetId
  };
};

/**
 * Invitations body (R-1, POST /invitations). Contract per 004_Invitations:
 *   { batch_id, analyst_email, spreadsheet_id, exclude_supplier_request_ids, timestamp, payload_version }
 * payload_version is stamped by Webhook.call.
 *
 * @param {Object} args  { batchId, analystEmail, spreadsheetId, [excludeSupplierRequestIds=[]] }
 */
Payload.invitations = function (args) {
  Payload._requireArgs(args, ['batchId', 'analystEmail', 'spreadsheetId'], 'invitations');
  var exclude = args.excludeSupplierRequestIds || [];
  if (!Array.isArray(exclude)) throw new Error('Payload.invitations: excludeSupplierRequestIds must be an array.');
  return {
    batch_id:                     args.batchId,
    analyst_email:                args.analystEmail,
    spreadsheet_id:               args.spreadsheetId,
    exclude_supplier_request_ids: exclude.map(function (id) { return String(id).trim(); }).filter(Boolean),
    timestamp:                    new Date().toISOString()
  };
};

/**
 * Portal-invite body (API-04, POST /portal-invite). The router ties the call to the workspace by spreadsheet_id.
 *
 * @param {Object} args  { correlationId, userEmail, [role='analyst'], spreadsheetId }
 */
Payload.portalInvite = function (args) {
  Payload._requireArgs(args, ['correlationId', 'userEmail', 'spreadsheetId'], 'portalInvite');
  return {
    correlation_id: args.correlationId,
    user_email:     args.userEmail,
    role:           args.role || 'analyst',
    timestamp:      new Date().toISOString(),
    spreadsheet_id: args.spreadsheetId
  };
};

// --- Private ---------------------------------------------------------

/**
 * Throw when any listed argument is absent. "Absent" is undefined, null, or a blank string; `false`, `0` and `[]`
 * are values (is_initial is a boolean, and arrays are shape-checked by the builder that owns them).
 */
Payload._requireArgs = function (args, names, flow) {
  if (!args) throw new Error('Payload.' + flow + ': args is required.');
  var missing = names.filter(function (n) {
    var v = args[n];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
  if (missing.length) {
    throw new Error('Payload.' + flow + ': missing required argument(s): ' + missing.join(', ') + '.');
  }
};
