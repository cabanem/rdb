/**
 * @file 008_Version.gs (SDC library)
 * Version constants for the SDC library. Single source of truth for all three version axes:
 *
 *   LIBRARY - semver of the library code itself. Bumps on any release.
 *   PAYLOAD - webhook contract version. Bumps when payload SHAPE changes (renames, type changes).
 *             Stamped onto every webhook by Webhook.call. R-1 reads this to handshake.
 *   SCHEMA  - workbook schema version the library expects. Bumps when the structural shape of the workbook changes (sheets,
 *             columns, label strings). Migrations.run reconciles workbooks to this version.
 *
 * These three axes version independently. A library bump is not a payload bump is not a schema bump.
 *
 * Consumer access:         SDC.Version.LIBRARY, SDC.Version.PAYLOAD, SDC.Version.SCHEMA
 * Library-internal access: SDC_LIBRARY_VERSION, SDC_PAYLOAD_VERSION, SDC_SCHEMA_VERSION
 *
 * Both forms point at the same value; the bare aliases exist because library-internal code reads them in lots of places and SDC.Version.X
 * is awkward when you're already inside the library.
 *
 * --- Payload version history -----------------------------------------
 *   1.0 - Initial release.
 *   2.0 - Provision payload: renamed config_json_file_id to drive_id_config_json; added is_initial (boolean, menu-derived).
 *         Validate and portal-invite payloads unchanged.
 *   3.0 - Provision payload: added output_drive_folder_id, reminder_days_1, reminder_days_2, reminder_days_3
 *         (all required, all sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged.
 *   4.0 - Provision payload: added kickoff_email_body (required string: supplier-facing pre-invite email body,
 *         sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged.
 *   6.0 - Provision payload: added config_fingerprint (required string; SHA-256 hex of serialized config content, excluding
 *         _meta). Validate and portal-invite payloads unchanged.
 *   7.0 - Provision payload: added expected_date (required string, YYYY-MM-DD, date-only, rendered in the workbook's timezone;
 *         sourced from 1_customer via Preflight). Validate and portal-invite payloads unchanged.
 *   8.0 - Provision payload: removed reminder_days_1/2/3; added reminder_days (required, non-empty array of positive integers, analyst-entered
 *         order preserved; sourced from the single reminder-cadence field on 1_customer via Preflight/Customer). Validate and portal-invite
 *         payloads unchanged.
 *   9.0 - NOT RECORDED at release time. The shipped builder differs from the 8.0 description by: application_name, last_day_for_submission,
 *         has_seeded_data, seeded_data_drive_id, seeded_data_index_key, seeded_data_sheet_name, seeded_data_xlsx_file_id, spreadsheet_id.
 *         Confirm and reword before the next release.
 *  10.0 - Provision payload: added seeded_data_header_row and seeded_data_first_data_row (integers, 1-based Excel rows of the seed sheet's
 *         header and first data row; null when has_seeded_data is false; defaulted to 1 / header+1 by Preflight when the analyst leaves
 *         them blank). Config JSON gains a derived _customer block (see Drive.serializeConfig). Validate and portal-invite payloads unchanged.
 *  11.0 - Provision payload: removed supplier_instructions, kick_off_email_body, has_seeded_data, seeded_data_drive_id, seeded_data_index_key,
 *         seeded_data_sheet_name, seeded_data_header_row, seeded_data_first_data_row and seeded_data_xlsx_file_id. Incumbent data and
 *         supplier messaging are no longer configured in the workbook; the seed XLSX export stage is gone from Provision.run.
 *         Validate and portal-invite payloads unchanged.
 *  12.0 - Provision payload: removed application_name, output_drive_folder_id and last_day_for_submission; added customer_logo_url
 *         (string, '' when the analyst leaves the field blank; public http(s) URL of the logo image otherwise). The customer block is
 *         now exactly: client_name, analyst_email, expected_date, reminder_days, target_vms, customer_logo_url (variant count is
 *         consumed by Variant.serializeAll and travels as template_file_ids). Validate, preview, invitations and portal-invite
 *         payloads unchanged.
 *  12.1 - Provision payload: added supplier_manager_email (string; the client-side supplier manager's address from 1_customer,
 *         required at provision and address-shaped per Preflight 5f; '' only when a caller bypasses Preflight). Purely additive,
 *         hence the first MINOR bump: a receiver that accepts 12.0 keys needs only to accept one more. Nothing in the workbook
 *         consumes the value. Validate, preview, invitations and portal-invite payloads unchanged.
 *  12.2 - Provision payload: added customer_logo_file_id and customer_logo_drive_url (strings; the Drive ID and
 *         https://drive.google.com/file/d/<id>/view link of the logo image the analyst uploaded, landed in the engagement
 *         folder and shared with the integration principal like the config JSON; '' when absent). customer_logo_url is
 *         KEPT but DEPRECATED: it carries a public URL only for a workbook that still holds one in the cell, '' otherwise.
 *         Workato turns the file ID into a displayable URL (fetch via the Drive connection, publish); the library never
 *         resizes or normalises the image. Additive, minor bump. Validate, preview, invitations and portal-invite unchanged.
 *  12.3 - Provision payload: added customer_logo_mime_type (string; 'image/png' or 'image/jpeg', decided from the file's
 *         magic bytes by Logo.resolve for uploaded and pasted Drive files alike; '' for a legacy public URL or no logo).
 *         Workato no longer has to ask Drive for the type. Deliberately NOT added to the _customer export block: that block
 *         is inside config_fingerprint, and a new key there would make every workbook's next Update cut a new version.
 *         Additive, minor bump. No schema change. Validate, preview, invitations and portal-invite unchanged.
 *
 * --- Schema version history ------------------------------------------
 *   1.6 - 1_customer labels aligned to the v0.9.9 template; seed header/first-data-row fields added.
 *   1.7 - Repair release. PRIMARY_KEY_COLUMNS reconciled to the template (4_fields, 5_lookups, 3_users,
 *         4_complex_validations only; _pk_<name>_ headers; 5_lookups data starts at row 6). Migration removes the stray
 *         PK column that library <= 1.7.0 inserted into 6_variants and 4_complex_validations and repairs 5_lookups rows 6-8.
 *         PrimaryKey.setupColumns no longer inserts columns; Preflight verifies layout anchors (Layout.verify).
 *         Payload unchanged (10.0): the serialized sheet grids return to the shape the connector already parses.
 *   1.8 - Routing. _developer_settings gains router.baseUrl, router.apiToken and meta.workspace_key; the five
 *         webhook.*Url rows and webhook.apiPlatformToken are no longer read (the migration leaves them in place and
 *         copies apiPlatformToken into router.apiToken when that is blank). Every workbook → Workato call is now
 *         POST router/route with the envelope {spreadsheet_id, correlation_id, path, is_initial, payload}.
 *         Payload unchanged (10.0): the inner payloads are what the workspace endpoints already read; only the
 *         transport changed. Invitations: the exclude-list contract (send-all by default) is now the library flow.
 *   1.9 - 1_customer loses the six seed-data rows (incumbent flag, Drive file ID, sheet name, index key, header row, first data
 *         row) and the two supplier-messaging rows (portal instructions, kick-off email). The migration deletes the rows by named
 *         range (label text as fallback), drops the named ranges and renumbers column B. Payload bumps to 11.0 with this schema.
 *   1.10 - 1_customer converges on the seven implementation attributes: "Application name", "Drive folder ID" and "Last day for
 *         data submission" leave (rows deleted, cfg_application_name / cfg_output_folder_id / cfg_last_day_for_submission removed);
 *         "Customer logo public link" arrives (row inserted below the last field, anchored as cfg_customer_logo_url, optional).
 *         Labels and CUSTOMER_FIELDS drop the three keys and gain customerLogoUrl; the 1.4 -> 1.5 migration keeps the retired
 *         last-day label as a literal. All seven fields are required at provision. Target VMS and Variant count become pick
 *         lists (registry `options`; the migration stamps the dropdowns, Preflight enforces the list). Payload bumps to 12.0.
 *         NOTE: schema_version is now stamped as TEXT ('1.10' in an automatic-format cell becomes the number 1.1); when stamping
 *         BASE / master_config by hand, enter it as text ('1.10 with a leading apostrophe) or set the cell format to plain text first.
 *   1.11 - 5_lookups loses its primary-key column (mis-modelled per-table entity stamped per row, never read). PRIMARY_KEY_COLUMNS
 *         drops the sheet; the migration deletes the column where the old fingerprint is found. Payload unchanged (12.0).
 *   1.12 - 1_customer gains "Supplier manager email" (row inserted directly below "Customer logo public link", anchored as
 *         cfg_supplier_manager_email, registry type email, required). Labels and CUSTOMER_FIELDS gain supplierManagerEmail;
 *         Preflight 5f checks the address shape. Payload bumps to 12.1 (supplier_manager_email added to /provision).
 *   1.13 - 1_customer: "Customer logo public link" is reworded to "Customer logo" (same row, same named range
 *         cfg_customer_logo_url; the migration re-stamps the label and writes the registry help text as a note on the value
 *         cell; the value is left alone). CUSTOMER_FIELDS: customerLogoUrl becomes customerLogo, type driveFile (the cell holds
 *         the Drive link of a file Logo.upload landed, or a legacy public URL). Preflight 5d becomes Logo.resolve and runs for
 *         validate/preview too. Payload bumps to 12.2.
 */

var Version = Object.freeze({
  LIBRARY: '1.17.0',
  PAYLOAD: '12.3',
  SCHEMA: '1.13'
});

// Library-internal aliases - used by Config, Drive, Webhook, Migrations.
var SDC_LIBRARY_VERSION = Version.LIBRARY;
var SDC_PAYLOAD_VERSION = Version.PAYLOAD;
var SDC_SCHEMA_VERSION = Version.SCHEMA;