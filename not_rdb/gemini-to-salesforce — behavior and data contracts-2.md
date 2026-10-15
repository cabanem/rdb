# gemini-to-salesforce — behavior and data contracts

Oct 15, 2026 · @Emily Cabaniss

## Scope

This is the reference to check a change against: for every way the project can be invoked, what it requires, what it does in order, what it does on failure, and what it leaves behind — then the shapes of every piece of state it reads or writes. Derived from the v6 export (`app_gemini-to-salesforce-6`, 15 files, Apps Script V8) by reading the code, not the comments alone; where a file's header and body agree it is stated once.

How to read the contract tables:

- **Pre** — what must be true before the function does anything useful; a failed precondition is the first thing it throws.
- **Effects** — side effects in the order they happen. Order matters: it decides what state exists after a crash between steps.
- **On failure** — what is thrown vs. swallowed, and which path (log row, Chat message, sheet cell, `_queue` row) carries it.
- **Leaves** — the durable state after a normal run.

Gaps in this reference — the dashboard client, ConfigEditor's per-field checks, and retired code — are listed in the last section rather than guessed at.

## Time-driven entry points

All three run as the account that created the triggers. The two pollers share one script lock, so they never overlap each other or a dashboard config save; a run that finds the lock held exits silently (`tryLock(0)`). `refreshSchema` does not take the lock.

### processIngestion() — every 5 min

|  |  |
| --- | --- |
| Pre | `readConfig_()` parses (required keys present, `output_fields` non-empty, no wire-key collision). Runner has `canListChildren` + `canAddChildren` on Intake, Processed, Failed, Pending (`assertFolderAccess_`). |
| Effects, per file in Intake (any type) | 1. Skip if `appProperties.g2s_claimed = 'true'` (copied on a prior poll). 2. Build content parts: Google Doc → text; PDF ≤ 15 MB → inline base64; .docx/.doc → temp Google Doc → text → temp trashed. 3. POST Vertex `generateContent` (prompt = `prompt_template` + `[[Label]]` format instruction; grounding tool if `grounding`). 4. Parse `[[Label]]` sections into label → text; unmatched labels blank; no matches at all → whole body into the first field. 5. Create the review sheet (new spreadsheet in runner's My Drive root, then moved into Pending). 6. Claim the original: `moveTo(Processed)`; on a permission error, copy to Processed and stamp the original `g2s_claimed`. 7. If a copy was kept, repoint the sheet's `Original file` link and `Source file ID` at the copy. 8. Chat card "Contract staged for review". 9. `_logs` INFO `Staged <name>` with correlation id and sheet URL. |
| After the loop | Heartbeat row 1 of `_queue` stamped. |
| On failure, per file | Exception caught: `_logs` ERROR `Extract failed: <name>`; original claimed into Failed (swallowed if that also fails — file stays in Intake and retries next poll); Chat text message. Loop continues. |
| On failure, run level | Config or folder check throws: `_logs` ERROR `Run failed`, re-thrown (Apps Script failure email), heartbeat NOT stamped. |
| Leaves | Original in Processed (or Failed, or still in Intake with `g2s_claimed`); review sheet in Pending with Status `Pending Review`, both checkboxes false. |
| Duplicate window | Crash between step 5 and step 6 → a second review sheet next poll. Documented, not guarded. |

### processApprovals() — every 5 min

|  |  |
| --- | --- |
| Pre | Config parses. Runner has list + add on Pending, Pushed, Cancelled. |
| Effects, per Google Sheet in Pending | 1. `readApproval_` (label-scanned meta block + header-located grid). 2. `nextAction_`: `Cancel?` ticked → **cancel**; else `Approved?` ticked → **push**; else **wait**. 3. cancel: Status `Cancelled` + `Cancelled at`; move to Cancelled; INFO `Cancelled <name>`. 4. wait: if Status is `Cancelled` (sheet was moved back by hand) reset to `Pending Review`; add a `_queue` row. 5. push: `validateApproval_` against the cached schema — any bad cell throws with every bad cell named; `pushToWorkato_` (POST, throws on non-2xx with the recipe's `message`/`field` when present); Status `Pushed` + `Pushed at`; move to Pushed; INFO `Pushed <name>`. |
| After the loop | `_queue` table cleared and rewritten from the collected rows; heartbeat row 2 stamped. |
| On failure, per sheet | Status `Error` + `Last error` (first 500 chars); `_queue` row with the error; if the error text differs from the sheet's previous `Last error`: `_logs` ERROR `Push failed: <name>` + Chat text. A repeat of the same error is silent in the log and Chat (still visible on the sheet and the dashboard). Sheet stays in Pending. |
| On failure, run level | As above: ERROR `Run failed`, re-thrown, heartbeat not stamped, previous `_queue` snapshot stands. |
| Leaves | Pushed sheets in Pushed; cancelled in Cancelled; everything else still in Pending and mirrored in `_queue`. |
| Idempotency | `correlation_id` from the sheet rides in the body and `X-Correlation-Id` header; the recipe is expected to upsert on it. A sheet that was pushed but failed to move is re-pushed next poll with the same id. |

### refreshSchema() — daily at 06:00 script time

|  |  |
| --- | --- |
| Pre | Config parses and has `workato_schema_url`; Script Property `WORKATO_WEBHOOK_SECRET` set. |
| Effects | 1. GET `<workato_schema_url>?correlation_id=<fresh uuid>` with `api-token` header. 2. Reject non-200, `ok:false`, or an empty `fields` array. 3. Shape rows: one per field with a name and label; key = `toSnake_(label)`; picklist values to one JSON cell (throws if > 49,000 chars, naming the field); second label collapsing to the same key is dropped and reported. 4. Reconcile with `output_fields` through `wireKey_`. 5. `_schema` cleared and rewritten: fetched-at, unmatched Config labels, unmatched Salesforce fields, table. 6. `_logs` INFO summary; WARN for unmatched Config labels; WARN for collisions. |
| On failure | Throws before step 5 → nothing written, previous tab stands. No Chat message. |
| Leaves | `_schema` current; pollers pick it up on their next run via `loadSchema_()`. |

## Web app and dashboard endpoints

All of these execute as the deployer (`executeAs: USER_DEPLOYING`, access `DOMAIN`). The visitor is identified only by `Session.getActiveUser().getEmail()`, which the platform can withhold (then `''`). Everything returned to the browser is primitives — no `Date` objects. Errors thrown here reach the page's `withFailureHandler` as the message text, which `classifyError_` sorts into permission / authorization / missing / transient / other.

| Endpoint | Pre | Effects | On failure | Returns |
| --- | --- | --- | --- | --- |
| `doGet(e)` | none — a broken Config must not take the page down | Evaluates `Dashboard.html` as a template; `t.picker` = Config has `picker_url`; `t.guideUrl` = `guide_url` if it is an `https://` URL | Config read error swallowed → page renders without picker/guide | HtmlOutput, title "Contract Intake" |
| `getDashboardData()` | none | Reads Config, `_queue`, last 3,000 `_logs` rows, Intake folder URL and unclaimed-file count — each in its own try/catch | Each failed read becomes an entry in `access.problems`; page degrades per resource | `{generatedAt, pollMinutes:5, maxUploadBytes, intakeWaiting, intake:{picker, folderUrl}, access:{viewer, runsAs, contact, problems[]}, heartbeats:{ingestion, approvals}, queue[], today:{staged, pushed, errors}, errors[] (last 2 days, cap 100), activity[] (today, cap 100)}` |
| `uploadContract({name, size, base64})` | visitor on `upload_allowed_emails` (empty list = anyone); extension in pdf/docx/doc; size ≤ 15 MB | Decodes base64 to a blob (MIME from extension, not browser); creates the file in Intake as the deployer; sets its Drive description `Via dashboard upload by <who> at <iso>`; `_logs` INFO context `intake`, message `Uploaded <name> (<who>)`, details = file URL | Throws a plain-language reason (shown verbatim) | `{name, url}` |
| `importPicked({pick:{id,name,mimeType}, token})` | same allow-list; pick and token present | `DrivePicker.fetchPicked(pick, token)` downloads/exports with the **visitor's** token; then the same landing as upload with source `picker` and `(source: <drive url>)` in the description; log message `Imported <name> (<who>)` | Library throws its own readable errors; size cap applies | `{name, url}` |
| `getConfigForEdit()` | none — opens even when the sheet is invalid | Reads Config raw; computes `canEdit` (visitor = deployer, or on `config_allowed_emails`; empty list = deployer only); reads `_models` ids and `_schema` status. No writes. | Throws only if the `Config` tab is missing | `{schema: CONFIG_SCHEMA, locked: LOCKED_KEYS, values, revision (hash of keys+values in sheet order), canEdit, viewer, runsAs, contact, models[], fieldSchema:{fetchedAt, fields, unmatchedConfig[], unmatchedSf[]}}` |
| `validateConfigDraft(draft)` | `canEdit` | `checkDraft_`: coerce each editable key by its `FieldSpec`; skip unchanged keys; look up changed folder ids in Drive as the deployer; merge over current raw; run `parseConfig_` on the merge. No writes, no lock. | Access failure throws | `{ok, errors:{key→msg}, message, changed[]}` |
| `saveConfig(draft, revision)` | `canEdit`; script lock within 30 s (else throws "pipeline is running") | Re-reads the sheet; if its revision ≠ `revision` returns `stale:true` without writing; else validates as above; writes only changed keys cell-by-cell (`setValue`, so the `model` dropdown and notes survive; unknown key → appended row); `_logs` INFO context `config`, `Config saved by <who>`, details = changed key names (never values) | Access and lock failures throw; validation failures return `ok:false` | `{ok, stale, errors, message, changed[], revision}` |
| `refreshSchemaFromDashboard()` | `canEdit` (same rule as a save — the endpoint is hit as the deployer) | Calls `refreshSchema()` | Propagates the refresh error as a message | `SchemaSummary` `{fields, fetchedAt, unmatchedConfig[], unmatchedSf[], collisions[], message}` |

`LOCKED_KEYS` (`project_id`, `location`, `workato_webhook_url`, `workato_test_url`, `workato_schema_url`) are shown in the drawer but never written from it, regardless of what the browser sends; the list is enforced server-side.

## Manual and menu entry points

Run from the editor or the `Contract Intake` sheet menu, as whoever runs them. The menu exists but is not the operational route; the team works from the dashboard.

| Function | Where | Pre | Effects | Side effects to be aware of |
| --- | --- | --- | --- | --- |
| `setupTriggers()` | editor, once | `script.scriptapp` scope | Deletes any existing `processIngestion` / `processApprovals` / `refreshSchema` triggers, then creates all three (5 min, 5 min, daily 06:00) | Triggers become owned by the runner; the pipeline's identity changes if someone else runs this |
| `setupSchemaTrigger()` | editor | — | Daily `refreshSchema` trigger only; idempotent | Called by `setupTriggers` |
| `validateConfig()` / `validateConfigUi()` | editor / menu | — | Parses Config; logs or alerts the field list with wire keys | None |
| `checkAccess()` / `checkAccessUi()` | editor / menu | Advanced Drive | One line per folder: OK/FAIL, name, shared-drive vs My Drive, missing capabilities, owner note | None; read-only |
| `refreshModelList()` | menu | `cloud-platform` scope | GETs Vertex publisher models (≤ 10 pages of 200), filters out embedding/tts/image/live/audio/native/computer-use/robotics, dedupes by id preferring GA, rewrites `_models`, sets a dropdown on the Config `model` cell | Overwrites `_models`; adds data validation to one Config cell |
| `runTests()` | editor | — | 115 hermetic cases across 13 registrars; prints ok/FAIL/SKIP per case and a summary | None — no sheet, Drive, or network |
| `probeApiToken()` | editor | `WORKATO_WEBHOOK_SECRET` | One POST to the push URL; reports 200 / 400 / 401 meaning | May run the recipe |
| `runWorkatoTests()` | editor | `WORKATO_TEST_URL` Script Property (falls back to the production webhook URL) | Five live scenarios: happy path, bad token, missing token, missing correlation\_id, replay | **Two scenarios upsert a Salesforce record** (correlation\_id `TEST-<ms>`) unless `RUN_SF_PATH` is false or the URL points at a sandbox |
| `debugPicker()` | editor | — | Logs picker config and DrivePicker version | None |

## Config tab

Column A is the key, column B the value; rows are label-scanned, blank keys skipped, a duplicate key keeps the last row. `parseConfig_` is the single definition of "valid" — the pollers and the drawer both call it. Three keys are read by code but absent from the drawer; two keys are in the drawer but not read by the pipeline.

| Key | Type (parse → drawer) | Required | Default | Read by | Drawer |
| --- | --- | --- | --- | --- | --- |
| `folder_id_ingestion` | string → folder | yes | — | both pollers, Intake, dashboard | editable, Drive-checked |
| `folder_id_processed` | string → folder | yes | — | ingestion | editable |
| `folder_id_failed` | string → folder | yes | — | ingestion | editable |
| `folder_id_pending` | string → folder | yes | — | both pollers | editable |
| `folder_id_pushed` | string → folder | yes | — | approvals | editable |
| `folder_id_cancelled` | string → folder | yes | — | approvals | editable |
| `prompt_template` | string → multiline | yes | — | ingestion | editable |
| `output_fields` | list (comma/newline) → list | yes, ≥ 1 | — | ingestion, approvals, schema | editable; `Label => Salesforce label` lines set `field_keys`; collision on wire key throws |
| `system_instruction` | string → multiline | no | `''` | ingestion | editable |
| `project_id` | string → text | yes | — | ingestion, models | **locked** |
| `location` | string → text | no | `global` | ingestion, models | **locked** |
| `model` | string → text | no | `gemini-2.5-pro` (in `callGemini_`) | ingestion | editable; dropdown from `_models` |
| `temperature` | number → number 0–2 | no | 0.2 (in `callGemini_`) | ingestion | editable |
| `max_tokens` | number → integer ≥ 1 | no | 8192 (in `callGemini_`) | ingestion | editable |
| `grounding` | bool (`true`/`yes`/`1`) → bool | no | false | ingestion | editable |
| `grounding_debug` | bool → bool | no | false | ingestion | editable |
| `workato_webhook_url` | string → url | yes | — | approvals, probes | **locked** |
| `workato_schema_url` | string → — | no (required by `refreshSchema`) | `''` | schema | **locked**, not in `CONFIG_SCHEMA` |
| `workato_test_url` | — → url | no | — | nothing (Script Property `WORKATO_TEST_URL` is what `runWorkatoTests` reads) | **locked**, display only |
| `workato_shared_secret` | string → — | no | `''` | nothing (retired) | not shown |
| `chat_webhook_url` | string → url | no | `''` (notifier logs and skips) | both pollers | editable |
| `upload_allowed_emails` | list, lower-cased → list | no | `[]` = anyone | Intake | editable |
| `config_allowed_emails` | list, lower-cased → list | no | `[]` = deployer only | ConfigEditor, Schema | editable |
| `picker_url` | string → url | no | `''` = picker off | WebApp | editable; next page load |
| `guide_url` | string → url (must be `https://`) | no | `''` | WebApp | editable; next page load |
| `support_contact` | string → text | no | `''` | WebApp, ConfigEditor | editable |

The defaults for `model`, `temperature`, and `max_tokens` live in `callGemini_`, not in `parseConfig_`; `parseConfig_` returns `''`/`undefined` and the Gemini seam substitutes. The review sheet's `Model` row records `cfg.model || 'gemini-2.5-pro'` independently, so the two must stay in step.

## Review sheet

One spreadsheet per contract, tab `Review`, no bound code, created by `createReviewSheet_` and read by `readApproval_`. Reads are label-scanned (trimmed, case-insensitive) within the first 30 rows for the meta block, and the grid is located by its header, so the reviewer can insert rows or reorder the meta block without breaking the poller. Writes back (`setMeta_`) update the labelled row if present, else append a new bold-label row.

| Rows | Col A | Col B / C | Written by | Read by |
| --- | --- | --- | --- | --- |
| 1 | `Original file` | `=HYPERLINK(url, name)` | create; `repointSheet_` after a copy-claim | — |
| 2 | `Source file ID` | Drive id | create; repoint | approvals → payload `source.file_id` |
| 3 | `Source file name` | string | create | payload `source.file_name` |
| 4 | `Correlation ID` | uuid | create | payload, header, `_queue`, logs |
| 5 | `Extracted at` | ISO string | create | payload `extracted_at`, `_queue` |
| 6 | `Model` | model id | create | payload `model` |
| 7 | `Status` | `Pending Review` → `Pushed` / `Cancelled` / `Error` | create; `mark*_` | `_queue`; wait-path reset |
| 8 | `Approved?` | checkbox | create (false) | `nextAction_` |
| 9 | `Cancel?` | checkbox with note | create (false) | `nextAction_` (takes precedence over Approved) |
| appended | `Pushed at`, `Cancelled at`, `Last error` | ISO / ISO / first 500 chars | `markPushed_`, `markCancelled_`, `markError_` | `lastError` → repeat-suppression |
| 11 (meta + 2) | `Field` | `Extracted` · `Approved` | create (bold, frozen) | grid locator |
| 12 … | one row per `output_fields` label, Config order | B = model text verbatim, never edited · C = seeded by the plan: option label / checkbox / Date / model text, or blank + `#fff3cd` when the schema rejects the text; validation rule and note attached after the values | create | B → `provenance.extracted`; C → gate → `fields` |
| grid end + 2 | `Grounding sources` | `title — uri` per line, or `(none)` | create | grid terminator (reads stop here or at the first blank label) |

Column widths 220 / 420 / 420; rows frozen through the grid header. A sheet created before the labels were sentence-cased still reads, because label comparison is case-insensitive.

The `Approved` cell rules by schema type (ReviewSheet.gs): single picklist → strict in-cell dropdown (invalid input rejected) when ≤ 500 options, note only above that; multipicklist → advisory dropdown (warning, not rejection) plus the note "Pick one from the list, or type several separated by ";""; boolean → checkbox; date → date picker, format `yyyy-mm-dd`; everything else → plain cell, highlighted with the gate's message as a note when the gate would reject the seeded text. With no schema cached, every cell is the model's text with no rules.

## Machine-owned tabs

All four live in the Config spreadsheet, are underscore-prefixed, and are positional (not label-scanned). Their layouts are the contract between their one writer and their readers.

| Tab | Writer (mode) | Readers | Layout |
| --- | --- | --- | --- |
| `_logs` | `writeLog_` (append; also `console.*` first) | `getDashboardData` (last 3,000 rows), humans | Header row: `Timestamp` (Date) · `Level` (INFO/WARN/ERROR) · `Context` (`processIngestion`, `processApprovals`, `intake`, `config`, `refreshSchema`) · `Correlation ID` · `Message` · `Details` (a bare URL when the dashboard should link it). ERROR rows `#fde7e9`, WARN `#fff4e5`. Created with headers on first write. |
| `_queue` | `processApprovals` (overwrite from row 4) + `heartbeat_` (rows 1–2) | `getDashboardData` | A1 `Last ingestion check` / B1 Date · A2 `Last approvals check` / B2 Date · row 4 header `Contract` · `Status` · `Approved?` · `Extracted At` · `Last Error` · `Sheet URL` · `Correlation ID` · `Source URL` · rows 5+ one per sheet still in Pending; an unreadable sheet gets Status `Unreadable`. |
| `_schema` | `refreshSchema` (overwrite) | `loadSchema_` per poller run; `schemaStatus_` for the drawer | A1 `Fetched at` / B1 ISO · A2 `Config labels not in Salesforce` / B2 comma list · A3 `Salesforce fields not in Config` / B3 comma list · row 5 header `Key` · `Name` · `Label` · `Type` · `Length` · `Scale` · `Precision` · `Controller` · `Values` · rows 6+ one per createable field; `Values` is JSON `[{value, label, valid_for[]}]` for picklist/multipicklist, blank otherwise. Header is located by its first two cells on read. |
| `_models` | `refreshModelList` (overwrite) | `readModelIds_` for the drawer; the `model` cell's dropdown | Header `Model` · `Launch stage` · `Version` · `Fetched`; one row per surviving publisher model. |

Log message prefixes the dashboard counts on: ` Staged  ` → today.staged, ` Pushed  ` → today.pushed, level ERROR → today.errors. Changing those prefixes changes the dashboard numbers.

## Workato payload and the wire-key join

`buildPayload_(approval, cfg, typedFields)` produces the body below; `pushToWorkato_` POSTs it as JSON with headers `api-token: <WORKATO_WEBHOOK_SECRET>` and `X-Correlation-Id: <correlation_id>`. The body's `correlation_id` is authoritative; the header exists for Workato job search.

```json
{
  "correlation_id": "<uuid minted at sheet creation>",
  "source": {
    "file_id": "<Drive id of the kept original>",
    "file_name": "<original name>",
    "drive_url": "https://drive.google.com/file/d/<file_id>/view"
  },
  "extracted_at": "<ISO 8601>",
  "model": "<model id recorded on the sheet>",
  "fields": { "<wire_key>": <typed value | null>, ... },
  "provenance": { "extracted": { "<wire_key>": "<model text, raw>", ... } }
}
```

`fields` carries the gate's typed values (string, number, boolean, or `null` for a blank cell) when `processApprovals` builds it; the raw Approved cells when tests or a dry run omit `typedFields`. `provenance.extracted` is always the raw Extracted column. Both are rekeyed from review-sheet labels to wire keys by `rekey_`.

**The wire key** is the one vocabulary shared by the payload, the `_schema` cache, and the Workato recipe:

| Side | Derivation | Example |
| --- | --- | --- |
| Config label, bare line | `toSnake_(label)` | `Payment Terms` → `payment_terms` |
| Config label with alias `Label => Salesforce label` | `toSnake_(Salesforce label)`; the label still appears on the prompt and sheet | `Countries where services => Countries Supplying Services` → `countries_supplying_services` |
| `_schema` row | `toSnake_(Salesforce field label)` | `Countries Supplying Services` → `countries_supplying_services` |

`toSnake_`: lowercase, every run of non-alphanumerics → `_`, leading/trailing `_` trimmed. Two Config lines or two Salesforce labels collapsing to one key is an error (Config) or a reported collision with the first kept (schema). No mapping table exists in code; a Salesforce rename shows up as an "unmatched Config label" warning, not a silent regression.

**Schema endpoint** (`GET <workato_schema_url>?correlation_id=<uuid>`, same `api-token` header) must return `200` with `{ ok: true, fields: [ { name, label, type, length, scale, precision, controller, values: [ { value, label, valid_for: [] } ] } ] }`. `fetchSchema_` rejects non-200, non-JSON, `ok: false`, and an empty `fields` array, so a bad response never overwrites the cache. The endpoint caches on `correlation_id`; a fresh uuid per refresh bypasses that cache on purpose.

## Gate normalization rules

`validateApproval_(approval, cfg, schema)` is pure and runs two passes over the Approved column in `output_fields` order. Pass 1 types each cell on its own with `normalizeValue_`; pass 2 re-checks dependent picklists against their controller's already-normalized value. Every failure is collected; the message is `Not sent — fix the Approved column. <label>: <why> | <label>: <why>` and the sheet stays in Pending.

Two rules precede the type switch: a blank cell (null, or whitespace-only string) → `null`, always OK; a label with no schema entry (no cache, or the label did not join) → trimmed pass-through, which is the pre-gate behaviour.

| Salesforce type | Accepts | Emits | Fails when |
| --- | --- | --- | --- |
| `picklist` | an option's API value or label, trimmed, case-insensitive | the option's **API value** | no match — message lists up to 12 option labels then `… N more` |
| `multipicklist` | parts split on `;` or newline (commas are not separators), each matched as above; duplicates dropped | API values joined with `;`; `null` if nothing survives | any part fails to match |
| `boolean` | a real boolean; or `true yes y 1 x ✓ checked` / `false no n 0 unchecked` | `true` / `false` | any other spelling |
| `date` | a `YYYY-MM-DD` string (passed through untouched); a Date cell; a parseable string | `yyyy-MM-dd` formatted in the **script time zone** (`America/New_York`) | unparseable |
| `datetime` | Date cell or parseable string | ISO 8601 UTC | unparseable |
| `int` | number cell; or the first signed decimal in the string after stripping commas | the number | not numeric, or not whole |
| `double`, `currency` | as `int` | rounded to the field's `scale` | not numeric |
| `percent` | as `double` after removing `%` | rounded to `scale` | not numeric |
| `url` | trimmed, must match `^https?://\S+$` | the string, length-checked | not a full link; over `length` |
| `string`, `textarea`, `email`, `phone` | any text | trimmed | longer than `length` (when `length` > 0) |
| anything else (`reference`, `id`, new types) | any value | trimmed pass-through | never |

**Dependent picklists (pass 2).** For a picklist field with a `controller` whose normalized value is non-null: each chosen value's `valid_for` list is checked against the controller field's normalized API value. An empty `valid_for` means unrestricted. Failure messages: `"X" requires <controller label> to be set first` when the controller is blank, or `"X" is not valid when <controller label> is "<value>"`. The controller is looked up by Salesforce API name among the fields on the same sheet; a controller not in `output_fields` means the dependent can never pass unless its values are unrestricted.

**Date handling note.** A Sheets date cell arrives as a JavaScript Date at local midnight; `toISOString()` would move it to the previous day for zones east of UTC, so dates are formatted with `Utilities.formatDate` in the script zone and ISO strings are never re-parsed. Numeric slash dates in strings are read US-style by `new Date()`.

**Review-sheet seeding uses the same matcher.** `planApprovedCells_` (ReviewSheet.gs) runs the model's extracted text through `matchOption_` / `normalizeValue_` to decide what to seed: a picklist cell gets the matched option's *label* (not the API value — the gate converts it back at push time); a boolean gets the checkbox state; a date gets a real Date; other types keep the text and are highlighted with the gate's message as a note when the gate would reject it. So a cell that passes seeding will pass the gate unchanged, and the two cannot disagree about what is valid.

## Identity, secrets, and scopes

The pipeline has one identity: the account that ran `setupTriggers()` and deployed the web app. Every Drive, Sheets, Vertex, and Workato call in the pollers and the dashboard is that account's permission and that account's quota. The visitor's identity is only ever an email string for allow-lists and provenance; nothing is done *as* the visitor except the DrivePicker download, which uses a token the visitor's browser obtained.

| Entry point | Executes as | Visitor known as | Notes |
| --- | --- | --- | --- |
| Time triggers | trigger owner | — | Re-running `setupTriggers()` as another account silently moves the identity |
| `doGet`, `google.script.run` endpoints | deployer (`USER_DEPLOYING`) | `Session.getActiveUser()`; may be `''` | `access.viewer` vs `access.runsAs` on the dashboard tells users whose permissions apply |
| `importPicked` | deployer for the landing; **visitor's token** for the download | as above | Only call that touches a file the deployer may not see |
| Sheet menu / editor runs | whoever runs it | — | `runnerEmail_()` reports via `Drive.About`, falling back to the effective user |

**Script Properties** (the only store outside the Config spreadsheet):

| Property | Required | Used by |
| --- | --- | --- |
| `WORKATO_WEBHOOK_SECRET` | yes | push, schema refresh, live tests — holds the Workato Auth Token (name kept from the HMAC era) |
| `CONFIG_SHEET_ID` | no | `getConfigSpreadsheet_` — when set, the script opens that spreadsheet instead of the bound one |
| `WORKATO_TEST_URL` | no | `runWorkatoTests` — falls back to the production webhook URL if unset |

**OAuth scopes** declared in `appsscript.json`: `cloud-platform` (Vertex), `spreadsheets`, `drive`, `documents` (Word → text), `script.external_request`, `userinfo.email` (visitor identity), `script.scriptapp` (triggers). Advanced Drive Service v3 is enabled; it is required for the claim marker, the folder capability check, Word conversion, and runner identity — not only for `.docx` ingestion as the ContractIntake header says.

**Library**: `DrivePicker` referenced in development mode at version 0, so the host always runs the library's head, not a pinned version.

**Per-run cost shape** (relevant to the 6-minute execution cap and daily quotas): ingestion = 4 folder capability reads + per file one Gemini call, one spreadsheet create, one move, one Chat POST; approvals = 3 capability reads + one `openById` per sheet in Pending + per approved sheet one Workato POST + one `_queue` rewrite; dashboard load = one Config read, one `_queue` read, one 3,000-row `_logs` read, one Intake listing with a Drive v3 `get` per file.

## Dashboard client

Dashboard.html is one IIFE (\~900 lines of JavaScript, \~800 of CSS) with no framework and no build step. It holds two state objects, calls seven server functions, and re-renders the whole page from one snapshot. Nothing about Config keys is hard-coded: the settings form is generated from the `CONFIG_SCHEMA` the server sends. Every string from the sheets passes through `esc()` or `textContent`.

**Template evaluation (server-side, once per page load).** `doGet` evaluates two scriptlets: `<?!= DrivePicker.clientHtml() ?>` is included only when `t.picker` is true, and the guide link is emitted only when `t.guideUrl` is an `https://` URL. Both are fixed for the life of the page; changing `picker_url` or `guide_url` takes effect on the next load, not the next refresh.

### Client state

| Object | Fields | Lifetime |
| --- | --- | --- |
| `state` | `data` (last snapshot), `timer`, `inFlight`, `maxUploadBytes` (15 MB until the server's value arrives), `pollMinutes` (5, likewise), `pickerMounted` | page |
| `settings` | `meta` (last `getConfigForEdit` result, including `revision`), `dirty`, `open`, `busy`, `returnTo` (element to refocus on close) | drawer session |

### Load and render cycle

1. `load()` runs on start, every 60 s (`REFRESH_MS`), on `visibilitychange` to visible, and on the Refresh button. A call already in flight is skipped (`inFlight`), so a slow server never stacks requests.
2. Success → `render(data)`: replaces `state.data`, adopts the server's `maxUploadBytes` and `pollMinutes`, then rebuilds every region from scratch — access notice, drop-zone hint and intake count, heartbeat pills, four KPI tiles, queue table, errors table, activity table. Mounts the picker once if the server sent picker settings and `window.DrivePicker` exists.
3. Failure → `showError(err)`: the banner shows a plain-language lead chosen by `classify()` (a client-side copy of the server's `classifyError_` regexes, for the case where the whole call fails) plus the raw message under a details toggle. The timer keeps retrying.

Derived values the page computes, not the server:

| Display | Rule |
| --- | --- |
| Heartbeat pill | `Unknown` when `_queue` was unreadable; `Never run` when no timestamp; `Stale` when older than `pollMinutes × 3` (15 min); else `OK` + relative age |
| Awaiting-review tile footer | `Nothing waiting` / `N need attention` (Status `Error` or `Unreadable`) / `Oldest waiting <ago>` |
| Queue order | errored rows first, then oldest `extractedAt` first |
| Queue row links | name → `sourceUrl` (the original) when present; "Open review sheet" → `url` |
| Activity row link | `details` rendered as a link when it is a URL; label `Open file` when context is `intake` or message starts ` Uploaded  `, else `Open review sheet` |
| Blocked sections | each `access.problems[].what` (`the queue`, `the activity log`, …) blanks the tiles and lists that depend on it with a "not readable" note instead of showing zero |
| Access notice | one sentence naming whose permissions failed (`viewer === runsAs` → "your own account", else "the dashboard's account"), what could not be opened, and advice by bucket (authorization / permission or missing / transient / other) |

### Upload flow (local file)

1. Document-wide `dragover`/`drop` defaults are cancelled so a missed drop never navigates to the PDF. The drop zone also accepts click, Enter, and Space via a hidden `<input type="file" multiple accept=".pdf,.doc,.docx">`.
2. `sendAll` → `sendOne` per file. Client-side checks first: extension in `pdf/doc/docx`; size ≤ `state.maxUploadBytes`. A failing file gets a critical status row and never leaves the browser.
3. `FileReader.readAsDataURL`; the base64 tail after the comma is sent as `uploadContract({name, size, base64})`.
4. Success: the row's name becomes a link to the Drive file; status "Uploaded. It will be read within about N minutes…"; `load()` so the `Uploaded …` log row shows under Today. Failure: `Not uploaded: <server message>` verbatim.

Status rows are built with `intakeRow(name)`, which returns `{status(text, dotClass), link(url, label)}`. It is exposed as `window.Intake = { row, refresh }` — the seam the picker (and any future source) plugs into.

### Picker flow (Drive)

`mountPicker(p)` calls `DrivePicker.mount({button, url: p.url, mimeTypes: p.mimeTypes, onPicked, onError})` once. `onPicked(files, token)` runs per picked file: client-side size check against `sizeBytes` when the library reports it, then `importPicked({pick:{id, name, mimeType}, token})` with the **visitor's** token; success and failure render exactly like an upload with `Imported` / `Not imported` wording. `onError` writes one critical row labelled "Add from Drive".

### Settings drawer

1. `openSettings()`: remembers `activeElement`, shows scrim and drawer, disables both buttons, calls `getConfigForEdit()`.
2. `buildForm(meta)`: groups `meta.schema` by `group` in first-appearance order, one `<fieldset>` each. `renderField` by `spec.type`: locked keys → read-only value with "· set in the sheet"; `bool` → checkbox; `multiline` → tall textarea; `list` → textarea with the comma/newline value normalized to one-per-line; `number` → text input with `inputmode=decimal`; everything else → text input, and the `model` input gets a `<datalist>` of `meta.models`. A read-only viewer (`!meta.canEdit`) sees a "View only" notice naming `contact`, disabled controls, and hidden Validate/Save buttons. A final fieldset shows the Salesforce schema cache status (`fieldSchemaText`) with a Refresh-now button.
3. Any `input` event in the body (editors only) sets `dirty`, enables Validate and Save, and clears a green status.
4. `submitSettings(dryRun)`: `collectDraft()` reads every `[data-key]` control as a string (checkbox → `'true'`/`'false'`); untouched fields are sent too, the server writes only what differs. Dry run → `validateConfigDraft(draft)`; save → `saveConfig(draft, settings.meta.revision)`. Buttons are disabled and `busy` set until the response.
5. Response handling (`done`): `showFieldErrors` writes each `errors[key]` under its field (`cfg_<key>_err`), `errors._` goes to the status line. `stale:true` → status with a Reload-form button that reopens the drawer. `!ok` → "Not saved." and buttons re-enabled. Dry-run ok → "Looks good — N changes: …". Save ok → `dirty = false`, `meta.revision` replaced with the new token, `load()` so `support_contact` and the upload list show on the page.
6. `refreshFieldSchema()` → `refreshSchemaFromDashboard()`; on success replaces `meta.fieldSchema` and the status text, flagging unmatched Config labels as bad; on failure restores the previous text and says the cache is unchanged.
7. `closeSettings(force)`: a dirty drawer prompts "Discard your unsaved changes?" unless forced; Escape, the scrim, and the close button all route here; `beforeunload` warns when the drawer is open and dirty. Focus returns to `returnTo`.

What the client does not do: it never opens a review sheet, never reads Drive directly, keeps no storage, and has no code path that writes other than `uploadContract`, `importPicked`, `saveConfig`, and `refreshSchemaFromDashboard`.

## Not covered here

- **ConfigEditor per-field checks** (`coerceField_`, `differs_`, `errorKey_`): the type coercions behind the drawer's `errors` map are summarized by `FieldSpec.type` only.
- **Retired or unexercised code** that still compiles: `signPush_` and the `workato_shared_secret` key (HMAC era); `createInPlace_` (written but uncalled — review sheets and temp Docs still create-then-move); `schemaFetchedAt_` (superseded by `schemaStatus_`); the `Contract Intake` sheet menu as an operator route.
- **Three spellings of one function**: `uploaderEmail_`, `viewerEmail_`, and `emailOf_(Session.getActiveUser)` all return the lower-cased visitor email or `''`. The client's `classify()` is likewise a hand-copied twin of the server's `classifyError_`.
- **Test coverage boundary** is stated in the `Tests.gs` header: the pollers, `callGemini_`'s fetch, `createReviewSheet_`, Drive moves, Chat, the Workato POST, `_queue` writes, `doGet`, and all of the client are not under `runTests()`.
