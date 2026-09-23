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
 *
 * --- Schema version history ------------------------------------------
 *   1.6 - 1_customer labels aligned to the v0.9.9 template; seed header/first-data-row fields added.
 *   1.7 - Repair release. PRIMARY_KEY_COLUMNS reconciled to the template (4_fields, 5_lookups, 3_users,
 *         4_complex_validations only; _pk_<name>_ headers; 5_lookups data starts at row 6). Migration removes the stray
 *         PK column that library <= 1.7.0 inserted into 6_variants and 4_complex_validations and repairs 5_lookups rows 6-8.
 *         PrimaryKey.setupColumns no longer inserts columns; Preflight verifies layout anchors (Layout.verify).
 *         Payload unchanged (10.0): the serialized sheet grids return to the shape the connector already parses.
 */

var Version = Object.freeze({
  LIBRARY: '1.8.0',
  PAYLOAD: '10.0',
  SCHEMA: '1.7'
});

// Library-internal aliases - used by Config, Drive, Webhook, Migrations.
var SDC_LIBRARY_VERSION = Version.LIBRARY;
var SDC_PAYLOAD_VERSION = Version.PAYLOAD;
var SDC_SCHEMA_VERSION = Version.SCHEMA;
