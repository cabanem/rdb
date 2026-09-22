# Integrating the description-parser patch

## Where things are

Three Apps Script projects are involved. The zips show two of them.

| Project | Identifier in the shim | What it holds |
|---|---|---|
| `lib_sdc` | `SDC` | The platform library (Config, Provision, Validate, Migrations…). Version 1.7.0, schema 1.6, payload 10.0. |
| Description parser | `DP` | The four parser files. Its own library project. Not in `lib_sdc.zip`. |
| `bound_sdc-shim` | — | Container-bound. `onOpen` already nests `DP.dpMenu(ui)`. `description_parser.js` already has the five wrappers. |

So the parser is already wired as a second library. That is the right shape for now, and this patch keeps it.

## What changes

| Project | Change |
|---|---|
| Description parser (`DP`) | Replace `Extractor.js`, `DescriptionParser.js`, `Test.js` with the patched files. `AiAdapter.js` is unchanged. Save a new library version. |
| `bound_sdc-shim` | Bump the `DP` library version. Two optional edits below (`shim.diff`). No required code change. |
| `lib_sdc` (`SDC`) | Nothing. No schema change, no migration, no version bump. |

## Steps

1. **DP project.** Copy the three patched files over the existing ones. From the editor run `dpRunTests` (43 pass), or `node run-tests-node.js` in the repo. Then Deploy → Manage deployments → new library version. Label it with what changed, e.g. `spec dialects + lint`.

2. **Golden workbook shim.** Project Settings → Libraries → `DP` → pick the new version. Reload the sheet. Run *Description parser → 1. Scan descriptions* on the Sony config and read `_description_proposals`.

3. **Other workbook shims.** Same version bump, one shim each. Nothing else.

## Optional shim edits (`shim.diff`)

- `main.js`: guard the parser submenu with `if (typeof DP !== 'undefined')`. Today a workbook whose shim lacks the `DP` library throws in `onOpen` and loses the whole SDC menu. `typeof` on an undeclared identifier does not throw.
- `description_parser.js`: pass only `DP_*` properties to the library, add the missing semicolons. Behaviour is identical (the library already filters), but the shim no longer hands every property across.

## Things I checked

- **Export.** `Drive.serializeConfig` iterates `CONNECTOR_SHEETS_ORDER`, an allowlist. `_description_proposals` can never reach the payload.
- **Logs.** The parser appends `[Timestamp, Status, User, Message, Correlation ID]` to `_script_logs`. Same five columns as `LOG_HEADERS`. Messages are prefixed `[description-parser]`.
- **Sheet names.** The parser reads `_developer_settings` keys `fields`, `validations`, `lookupTables`, `logs` — the same keys `Config.build` reads. Header rows are found by anchor text (`_pk_fields_`), not by `FIELDS_LAYOUT` row numbers, so a layout drift breaks the two independently, not together.
- **Scopes.** With `DP_AI_MODE` off (or unset) the parser uses only Sheets, Properties and Session. No manifest change in the shim.
- **Migrations.** No `MIGRATION_CHAIN` entry. The patch writes to columns that already exist and creates one underscore tab.

## Later, if you want one library

Folding `DP` into `SDC` is mechanical: drop `dpLog_` in favour of `Log.append`, drop `dpSheetNames_` in favour of `Config.build(ss).sheets`, keep the `dp` prefix (it does not collide with anything in `lib_sdc`), change `DP.` to `SDC.` in the wrapper file. I would not do it yet. The parser has its own tests, its own release cadence, and a possible extra scope when AI is on. Keeping it out of the provisioning library keeps the provisioning library boring.

## One line still open

The review tab labels a disagreement `CONTRADICTION:`. Given the adoption conversation, `The spec says Optional — untick Required?` reads better. It is one string in `dpReviewLine_` in `DescriptionParser.js`. Say the word and I will change it before you push.
