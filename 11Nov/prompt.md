# Task: upload the customer logo from the analyst's computer instead of pasting a public link

## Context
Read first:
1. docs/architecture.md — §2 (Apps Script tier), §5.1–5.2 and §5.4 (Google Drive as a file hand-off)
2. docs/invariants.md — "Configuration and provisioning", "Platform constraints"
3. docs/generated/api-contracts.md — `POST /provision` (API-00): `customer_logo_url` is the field this replaces

Source in this repo:
- lib_sdc (library; identifier `SDC`): <path>
- bound_sdc-shim: <path>
- app_sdc-router (hosts the kickoff web app): <path>
- reference upload integration from Contract Intake (the dashboard's drag-and-drop: browser → base64 →
  `google.script.run` → Upload.gs creates the file in Drive): <path>

Scope: Apps Script only. The Workato side (fetching the file and publishing a displayable URL) is a separate
change; your last deliverable is the handoff for it.

## The change
Today the analyst finds a public URL for the customer logo and pastes it into the `Customer logo public link`
row of `1_customer`; it travels as `customer_logo_url`. Replace that with a plain file upload:

- The analyst clicks "Upload customer logo", chooses an image from their computer (or drops it on the control),
  sees a thumbnail and the file name, and is done. No sharing settings, no public links, no Drive navigation.
- The browser reads the file (FileReader → base64) and sends `{name, mimeType, sizeBytes, base64}` through
  `google.script.run` to a host shim that calls `lib_sdc`. Enforce the size cap in the browser before sending
  and again on the server; stay well under the `google.script.run` payload limit (a logo is a few hundred KB;
  cap at a few MB, state the number).
- `lib_sdc` decodes the bytes, checks the MIME type against an allow-list (PNG and JPEG at minimum; decide
  about SVG and say why), and lands the file in the engagement's Drive folder — the same place and the same
  sharing to the integration principal that the config JSON export uses today. Find that code path and reuse
  it; do not invent a second sharing mechanism. A re-upload replaces the previous logo file rather than
  accumulating copies.
- The file's Drive link is written into the `1_customer` cell (one row on the sheet, as now). The row label
  becomes `Customer logo`; the registry entry gets the new label and help text.
- On the wire, the export's `_customer` block and the `/provision` body carry the file's **ID** and its
  **Drive link**: `customer_logo_file_id`, `customer_logo_drive_url`. Keep `customer_logo_url` as an optional,
  deprecated field so this ships before the Workato side changes (additive → minor payload bump). Registry keys
  camelCase in `_customer.values`; wire keys snake_case.
- Fallback without the upload control: a pasted Drive link in the cell is accepted; `lib_sdc` resolves the ID,
  verifies the integration principal can read the file (copy-and-share it if not), and proceeds. Validate
  reports a clear message when the file is not an image, too large, or unreadable by the principal.

## Where the control lives
Both hosts, through one `lib_sdc` entry point:
1. The shim sidebar — a file input fits a 300 px panel; wire it into the sidebar's existing action flow and the
   "action in progress" window so the analyst sees upload → saved → cell updated.
2. The kickoff web app — the logo row of the `1_customer` form becomes the upload control with a thumbnail.
The HTML for the control should be written once and served to both hosts; investigate whether the sidebar
HTML already comes from `lib_sdc` and follow that pattern.

## Constraints
- Same constraints as the earlier handoffs: shim thin, logic in `lib_sdc`, Result / Stage.run /
  Log.forCorrelation patterns, the repo's own tests and deployment method, versions read from code.
- No new OAuth scopes: `lib_sdc` already writes files to Drive for the config export; confirm the upload needs
  nothing beyond that, so no analyst re-authorises. If it does need more, stop and say so.
- Schema bump with a migration step (label change on an existing row, help text, named range unchanged);
  idempotent; works on a workbook that still holds a public URL in the cell (treat it as the legacy field,
  keep sending it as `customer_logo_url`, do not fail Validate on it).
- Do not change the other customer attributes. Do not push the bytes to Workato; only the ID and link.
- `google.script.run` cannot reach library functions: every host gets one global shim per entry point.
- Do not normalise or resize the image here; leave rendering to the Workato side and say so in the handoff.
- The connector's grid-fallback label map on the Workato side keys on the row label; the handoff must carry
  the new label.

## Working method
1. Investigate and report: the `customer_logo_url` trace (cell → registry → export → payload), the
   config-export landing-and-sharing code path you will reuse, where the sidebar HTML is served from, the
   scope check, the size cap and MIME list you propose, and the file list. Stop for approval.
2. Implement with tests (registry, migration on legacy and fresh workbooks, export and payload shape,
   pasted-link fallback, MIME and size rejection, re-upload replaces). One commit per project touched.
3. Hand back: diff summary; version bumps and manifest changes for shim and kickoff app; template
   instructions; a manual test (upload in the sidebar → cell holds the link → Validate passes → `/provision`
   body shows id and link; same from the kickoff app; pasted-link fallback; a workbook still holding a public
   URL; oversize and non-image rejections); and the Workato-side handoff: the new fields, the deprecation of
   `customer_logo_url`, the new row label for `customer_label_map`, and what Workato must do to turn the file ID
   into a displayable URL (fetch via the Drive connection as UTL-13 does, publish, write the URL to
   Project.customer_logo_url / IMAGE_PUBLIC_URL_CLIENT).
