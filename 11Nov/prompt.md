# Task: pick the customer logo from Drive instead of pasting a public link

## Context
Read first:
1. docs/architecture.md — §2 (Apps Script tier), §5.1–5.2 and §5.4 (Google Drive as a file hand-off)
2. docs/invariants.md — "Configuration and provisioning", "Platform constraints"
3. docs/generated/api-contracts.md — `POST /provision` (API-00): `customer_logo_url` is the field this replaces
4. lib_drive-picker/README.js in full — especially §1 (why it is built this way), §5 (consuming it), §6 (origin
   registration), §8 (gotchas)

Source in this repo:
- lib_sdc (library; identifier `SDC`): <path>
- bound_sdc-shim: <path>
- app_sdc-router (hosts the kickoff web app): <path>
- lib_drive-picker (DrivePicker library + picker helper web app): <path>
- reference host integration from Contract Intake (host/INTEGRATION.md, Intake.gs `importPicked` shim): <path>

Read `VERSION` from lib_drive-picker/Code.js; the folder name and the code may disagree. Picker-helper
deployment facts (its /exec URL, `PICKER_ALLOWED_ORIGINS`, `PICKER_API_KEY`) are mine to supply; ask for them.

Scope: Apps Script only. The Workato side (fetching the picked file and publishing a displayable URL) is a
separate change; your last deliverable is the handoff for it.

## The change
Today the analyst finds a public URL for the customer logo and pastes it into the `Customer logo public link`
row of `1_customer`; it travels as `customer_logo_url`. Replace that with a Drive picker:

- The analyst clicks a "Choose logo from Drive" control, picks an image file from their own Drive (My Drive,
  Shared with me, Shared drives), and is done. No sharing settings, no public links.
- `lib_sdc` receives the pick, downloads it with the visitor's token (`DrivePicker.fetchPicked`), checks it is an
  image under a size cap, and lands a **copy** in the engagement's Drive folder — the same place and the same
  sharing to the integration principal that the config JSON export uses today. Find that code path and reuse it;
  do not invent a second sharing mechanism.
- The copy's Drive link is written into the `1_customer` cell (one row on the sheet, as now). The row label
  becomes `Customer logo` (it is no longer a public link); the registry entry gets the new label and help text.
- On the wire, the export's `_customer` block and the `/provision` body carry the copy's **file ID** and its
  **Drive link**. Proposed names: `customer_logo_file_id`, `customer_logo_drive_url`. Keep `customer_logo_url`
  as an optional, deprecated field for now so this ships before the Workato side changes (additive → minor
  payload bump). Registry keys follow the camelCase convention for `_customer.values`; wire keys snake_case.
- Fallback without the picker: a pasted Drive link in the cell is accepted; `lib_sdc` resolves the ID, verifies
  the integration principal can read the file (copy-and-share it if not), and proceeds. Validate reports a
  clear message when the file is not an image, too large, or unreadable by the principal.

## Design decisions to investigate and recommend (before building)
1. **Where the picker UI lives.** Candidates: (a) the kickoff web app in app_sdc-router — a full page and one
   script project, so one origin to allow-list; (b) a modal dialog opened from the shim sidebar (sidebar itself
   is ~300 px wide, too narrow for the overlay); (c) the sidebar directly. Verify whether HtmlService origins
   are per script project (README §6 says so); if they are, every bound shim is its own origin and (b)/(c) mean
   registering an origin per workbook. My expectation: (a) as the primary host, the pasted-link fallback in the
   workbook. If you believe (b) is workable, say what the origin story is.
2. **Where the DrivePicker dependency lives.** `lib_sdc` depending on DrivePicker (one place; hosts only need
   SDC plus a `google.script.run` shim) versus each host depending on it. Check that a library-of-a-library works
   with the shim's pinned-version discipline and what the added `drive.file` scope does to existing
   authorisations (every analyst re-authorises once?).
3. **Configuration.** One value, the helper's /exec URL, under a `picker` category — in `_developer_settings`
   for a linked workbook and Script Properties otherwise, following how `router.*` is stored. Presence of the
   value is the switch, as in Contract Intake.
4. **Image checks.** Allowed MIME types, size cap, and whether to normalise (no — leave rendering to the
   Workato side; say so).

## Constraints
- Same constraints as the two earlier handoffs: shim thin, logic in `lib_sdc`, Result / Stage.run /
  Log.forCorrelation patterns, the repo's own tests and deployment method, versions read from code.
- Schema bump with a migration step (label change on an existing row, help text, named range unchanged);
  idempotent; works on a workbook that still holds a public URL in the cell (treat it as the legacy field, keep
  sending it as `customer_logo_url`, do not fail Validate on it).
- Do not change the other customer attributes. Do not push the picked bytes to Workato; only the ID and link.
- `google.script.run` cannot reach library functions: every host gets one global shim per entry point.
- The connector's grid-fallback label map on the Workato side keys on the row label; the handoff must carry the
  new label.

## Working method
1. Investigate and report: the `customer_logo_url` trace (cell → registry → export → payload), the config-export
   landing-and-sharing code path you will reuse, your answers to the four decisions, the origin verification
   result, and the file list. Stop for approval.
2. Implement with tests (registry, migration on both legacy and fresh workbooks, export and payload shape,
   pasted-link fallback, image checks). One commit per project touched.
3. Hand back: diff summary; version bumps and manifest changes for shim and kickoff app; helper deployment
   steps I must do (allow-list entries, library version to pin); template instructions; a manual test
   (pick in the kickoff app → cell holds the link → Validate passes → `/provision` body shows id and link;
   pasted-link fallback; a workbook still holding a public URL); and the Workato-side handoff: the new fields,
   the deprecation of `customer_logo_url`, the new row label for `customer_label_map`, and what Workato must do
   to turn the file ID into a displayable URL (fetch via the Drive connection as UTL-13 does, publish, write
   the URL to Project.customer_logo_url / IMAGE_PUBLIC_URL_CLIENT).
