# Contract Intake (app_gemini-to-salesforce)

## Overview

Contract Intake turns a contract document into a Salesforce record with a human in the loop. A PDF, Word file, or Google Doc dropped into a Drive folder is read by Gemini on Vertex AI; the extracted terms are laid out on a per-contract Google Sheet; a reviewer corrects and approves them; the approved values are validated against Salesforce's own field definitions and pushed through a Workato API endpoint, which upserts the record. A web-app dashboard shows where every contract is, accepts new ones, and exposes the configuration.

It is one Apps Script project bound to a Config spreadsheet. There is no code in the review sheets, no database, and no server: the Drive folders are the queue, the sheets are the records, and two time-driven functions move things between them.

What it does, in order:

1. **Ingests** any supported file that lands in the Intake folder, by any route (Drive, dashboard upload, Drive picker).
2. **Extracts** the fields listed in Config with Gemini, using a prompt you control and an optional Google Search grounding tool.
3. **Stages** a review sheet whose Approved column is pre-typed from the cached Salesforce schema — dropdowns, checkboxes, date pickers — with anything the model got wrong highlighted for a decision.
4. **Notifies** the team Chat space with a card linking to the sheet.
5. **Validates** every approved value against Salesforce field types, picklist options, lengths, and dependent-picklist rules before anything leaves.
6. **Pushes** a typed payload to Workato with a correlation id minted at staging time, so retries are safe.
7. **Reports** everything to a dashboard: queue, heartbeats, today's counts, recent errors, and a settings drawer.

## Features

| Feature | What it does | Benefit, or the risk it removes |
|---|---|---|
| **Config-driven extraction** | Prompt and field list live in a sheet; adding a field is one line | No code change to add or rename a term; the drawer validates edits with the same parser the pollers use, so a bad config is refused rather than discovered at the next poll |
| **Frozen Extracted column** | The model's text is written once and never edited; the reviewer works in Approved | A free audit trail; the correction delta travels in the payload as provenance |
| **Schema-typed review sheet** | Approved cells get dropdowns, checkboxes, and date pickers from the cached Salesforce schema; non-matching values are left blank and highlighted with a note | Reviewers choose from valid options instead of typing into free text; invalid pushes are prevented at the sheet, not discovered at Salesforce |
| **Push gate** | Every Approved value is normalized to its Salesforce type and checked (options, lengths, numbers, dates, dependent picklists) before the POST; all failures reported at once | A sheet that would be rejected never reaches Workato; the reviewer fixes every cell in one pass; dates cannot shift a day across time zones |
| **Wire-key join** | One key — derived from the Salesforce field label or a `Label => Salesforce label` alias — is shared by the payload, the schema cache, and the recipe | No mapping table in code; a renamed Salesforce field shows up as a warning in Settings, never as a silently dropped field |
| **Correlation id per contract** | A UUID minted when the review sheet is created rides every push attempt | Workato/Salesforce upsert on it: a retried push updates rather than duplicates |
| **Script-lock serialization** | Both pollers and config saves take one script lock | Runs never overlap; a poll never reads a half-saved config |
| **Folder access preflight** | Every run checks the runner's `list` and `add` capabilities on each folder first | A sharing mistake becomes one readable `_logs` row naming the folder and capability, not a mid-run exception |
| **Claim by copy** | When Drive refuses to move an original the runner does not own, it is copied and the original is marked | Files dropped by anyone are processed; nothing is re-extracted on the next poll |
| **Heartbeats + queue snapshot** | Each poller stamps a timestamp when it finishes; approvals rewrites a `_queue` tab wholesale | A silently dead trigger looks different from a quiet day; the dashboard never opens review sheets to render |
| **Dual-write logging** | Every log line goes to Stackdriver first, then to `_logs` | A trail survives even when the sheet write is the thing that failed |
| **Repeat suppression** | A sheet failing the same way every poll is logged and announced once | Chat is not flooded; the sheet and queue row still show the error every run |
| **Fail-closed dashboard writes** | Upload and settings endpoints check the visitor against Config allow-lists; locked keys are enforced server-side | The web app runs as the deployer, so without this anyone with the URL could write as that account |
| **Degraded, not blank, dashboard** | Each data source is read in its own try/catch; failures become a notice naming whose permissions failed | A permission problem on one tab does not take the page down |
| **Hermetic test suite** | 115 cases over the pure functions, no network or Drive | Parsing, config, gate, and sheet-planning logic can be changed with confidence |

## Installation and setup

### Prerequisites

- **Config spreadsheet** this project is bound to (or referenced by Script Property `CONFIG_SHEET_ID`), with a `Config` tab of `key | value` rows. `_logs`, `_queue`, `_schema`, and `_models` are created by the script.
- **Six Drive folders** — Intake, Processed, Failed, Pending, Pushed, Cancelled — ideally in one shared drive where the runner is Content Manager. My Drive works with Editor, but originals the runner does not own are copied rather than moved.
- **GCP project with the Vertex AI API enabled** and the runner granted a Vertex user role. This is the project named in Config `project_id`, not the script's own sandboxed Cloud project; calls use the runner's OAuth token (`cloud-platform` scope).
- **Workato**: an API endpoint for the push (recipe upserts on `correlation_id`) and one for `/fetch-schema`, both behind an access profile using the native Auth Token method.
- Optional: a Google Chat incoming webhook; the DrivePicker helper web app (`lib_drive-picker`) for "Add from Drive".
- `clasp`, logged in as the account that will own the triggers and the deployment.

### Steps

1. **Push the code.** `clasp push` from the project folder.

2. **Fill the Config tab.** Required keys:

   | Key | Value |
   |---|---|
   | `folder_id_ingestion`, `folder_id_processed`, `folder_id_failed`, `folder_id_pending`, `folder_id_pushed`, `folder_id_cancelled` | Drive folder ids |
   | `prompt_template` | The extraction prompt; the `[[Label]]` format instruction is appended automatically |
   | `output_fields` | One field per line, in review-sheet order. Write `Label => Salesforce label` when the friendly label differs from the Salesforce field label |
   | `project_id` | GCP project for Vertex |
   | `workato_webhook_url` | Push endpoint URL |
   | `workato_schema_url` | Schema endpoint URL, without query string |

   Commonly set optional keys: `model` (default `gemini-2.5-pro`), `location` (default `global`), `chat_webhook_url`, `upload_allowed_emails`, `config_allowed_emails`, `picker_url`, `guide_url`, `support_contact`. The full key list with types and defaults is in the contracts reference.

3. **Set Script Properties.** `WORKATO_WEBHOOK_SECRET` = the Workato Auth Token. Optionally `CONFIG_SHEET_ID` and `WORKATO_TEST_URL`.

4. **Authorize.** Run `validateConfig()` from the editor as the runner account and accept the OAuth prompt. It logs the parsed field list with wire keys, or names the missing key.

5. **Check folder access.** Run `checkAccess()`. Every folder should print `OK`; a `FAIL` line names the folder and the missing capability. The pollers run this same check and refuse to start on a failure.

6. **Cache the Salesforce schema.** Run `refreshSchema()`. It writes `_schema` and logs any `output_fields` labels that do not join to a Salesforce field; add aliases for those. Until this has run once, review sheets have no dropdowns and the gate passes everything through.

7. **Install the triggers.** Run `setupTriggers()`: `processIngestion` and `processApprovals` every 5 minutes, `refreshSchema` daily at 06:00 script time, replacing any earlier copies. **The account that runs this owns the pipeline's identity.**

8. **Deploy the dashboard.** Deploy → New deployment → Web app → *Execute as: Me*, *Who has access: Anyone within the org*. Copy the `/exec` URL. Run `processApprovals()` once by hand so `_queue` exists and has a heartbeat before anyone opens the page.

9. **Optional — Drive picker.** Deploy the DrivePicker helper as its own web app and put its `/exec` URL in Config `picker_url`.

### Updating

| You changed | Do |
|---|---|
| Any `.js` used by the pollers or menu | `clasp push` — triggers run the latest code immediately |
| Anything the page calls (`Dashboard.html`, `WebApp.js`, `Intake.js`, `ConfigEditor.js`, `Schema.js`) | `clasp push`, then Deploy → Manage deployments → edit → *New version* → Deploy (or `clasp deploy -i <deploymentId>`). The URL does not change. |
| `appsscript.json` scopes | `clasp push`, re-run a function as the runner to re-authorize, redeploy the web app |
| `output_fields` or the prompt | Config only; applies to contracts extracted after the save |

### Testing

- `runTests()` — 115 hermetic cases; no network, no Drive. Results in the execution log.
- `probeApiToken()` — one POST to the push URL; 200 / 400 / 401 tells you whether the token and the recipe's validation are in play.
- `runWorkatoTests()` — five live scenarios against `WORKATO_TEST_URL` (falls back to the production URL). **Two of them upsert a Salesforce record** (`correlation_id` `TEST-<ms>`); point the property at a test recipe or set `RUN_SF_PATH = false` first.

## Architectural overview

### Flow

```
Drive: Intake ──processIngestion (5 min)──▶ Gemini ──▶ review Sheet in Pending ──▶ Chat card
                                                                │
                                              reviewer corrects Approved column, ticks Approved?
                                                                │
                 processApprovals (5 min) ──▶ Gate (typed against _schema) ──▶ Workato ──▶ Salesforce
                                                                │
                                            sheet → Pushed  (or stays in Pending with Status: Error)

refreshSchema (daily) ──▶ Workato /fetch-schema ──▶ _schema tab   (read by both pollers)
doGet / getDashboardData ──▶ _queue + _logs ──▶ Dashboard.html     (read-only projection)
```

### Entry points

| Invocation | Function | Runs as |
|---|---|---|
| Time trigger, 5 min | `processIngestion()`, `processApprovals()` | trigger owner |
| Time trigger, daily | `refreshSchema()` | trigger owner |
| Web app GET | `doGet()` | deployer |
| `google.script.run` | `getDashboardData`, `uploadContract`, `importPicked`, `getConfigForEdit`, `validateConfigDraft`, `saveConfig`, `refreshSchemaFromDashboard` | deployer; visitor identified by email |
| Sheet menu / editor | `setupTriggers`, `validateConfig`, `checkAccess`, `refreshModelList`, `runTests`, `runWorkatoTests` | whoever runs it |

### Modules

| File | Role |
|---|---|
| `ContractIntake.js` | Both pollers, extraction, review-sheet I/O, Config parsing, Chat, `setupTriggers`; also the shared utilities (`str_`, `parseList_`, `META`, `moveFile_`) |
| `Schema.js` | Fetch → `_schema` → in-memory map; pure shaping and reconciliation |
| `Gate.js` | Pure normalization/validation of the Approved column by Salesforce type |
| `ReviewSheet.js` | Pure plan of seeds, flags, notes, and rules; thin Sheets applier |
| `WorkatoPush.js` | Token auth, POST, error-text shaping |
| `Intake.js` | Upload and picker adapters → `stageBlob_` → Intake folder |
| `Claim.js`, `Access.js` | Custody of originals; folder capability preflight (both Drive v3) |
| `Snapshot.js`, `Logging.js` | `_queue` and `_logs` writers and readers |
| `WebApp.js` | `doGet`, `getDashboardData`, `summarizeLogs_`, `classifyError_` |
| `ConfigEditor.js`, `ConfigTools.js` | Drawer endpoints and `CONFIG_SCHEMA`; sheet menu and `_models` |
| `Dashboard.html` | The page: one IIFE, form generated from `CONFIG_SCHEMA`, no framework |
| `Tests.js`, `WorkatoTests.js` | Hermetic suite; live probes |

Every module follows the same split: a pure core (`interpret*_`, `*Rows_`, `plan*_`, `normalize*_`) that `Tests.js` exercises without a sheet or network, and a thin shell that touches Drive, Sheets, or HTTP.

### State

| Where | What | Owner / mode |
|---|---|---|
| `Config` tab | All settings, `key \| value`, label-scanned | humans and the drawer; source of truth |
| `_logs` tab | Audit trail, 6 columns | code, append-only |
| `_queue` tab | Heartbeats + snapshot of Pending | `processApprovals`, overwrite |
| `_schema` tab | Cached Salesforce field definitions | `refreshSchema`, overwrite; `{}` when absent means "no knowledge" |
| `_models` tab | Gemini model list for the `model` dropdown | `refreshModelList`, overwrite |
| Six Drive folders | The queue; a file's folder is its stage | pollers |
| Review sheets | Per-contract record: meta block, grid, sources; label-scanned | create once; `Status`/`Last error` updated |
| `appProperties.g2s_claimed` | Marks an original that was copied, not moved | `Claim.js` |
| Script Properties | `WORKATO_WEBHOOK_SECRET`, optional `CONFIG_SHEET_ID`, `WORKATO_TEST_URL` | admin |

### External boundaries

- **Vertex AI** — `generateContent` (runner's OAuth token; optional Google Search grounding) and the publisher model list.
- **Workato** — push POST and schema GET, both with the `api-token` header and `X-Correlation-Id`.
- **Google Chat** — incoming webhook, cards and text.
- **Drive v3 (advanced)** — `appProperties`, `capabilities`, Word → Doc conversion, runner identity.
- **DrivePicker library** — `clientHtml()` inlined into the page; `fetchPicked()` server-side with the visitor's token.

### Identity

Everything runs as one account: the one that ran `setupTriggers()` and deployed the web app. Its Drive permissions, Vertex role, and Apps Script quota are the pipeline's. Dashboard visitors are identified only by email for the allow-lists and for provenance; the only action taken with a visitor's own credentials is the Drive-picker download. Re-running `setupTriggers()` or redeploying as a different account silently changes all of this.

### Delivery guarantees

- Extraction is at-least-once; the only duplicate window is a crash between "review sheet created" and "original moved", which yields a visible second sheet a human can delete.
- The push is effectively exactly-once via the correlation id: a retry carries the same id and the recipe upserts.
- Approval is a cell value, never code in the artifact; the reviewer's sheet has no script and no auth of its own.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Nothing is processed, no errors | `_queue` heartbeats stale → check the triggers exist and belong to the runner (`setupTriggers()` as the right account). A run skipped because the other poller held the lock leaves no log line. |
| `Run failed` in `_logs` | The message names the missing Config key or the folder/capability the runner lacks. `checkAccess()` reproduces it. |
| `Extract failed: <file>` | Vertex error text is in Details: `Vertex 403` → API not enabled or runner lacks a Vertex role on `project_id`; `PDF too large` → > 15 MB; `Gemini blocked` / `empty response` → prompt or document; original moved to Failed. |
| Sheet stays on `Error`, `Last error` starts `Not sent — fix the Approved column` | The gate rejected the named cells; nothing reached Workato. Fix them, leave Approved? ticked. |
| `Workato 401` | Token wrong or the access profile is not attached to the endpoint. |
| `Workato 400` with a field name | The recipe's own validation; the field it names. |
| Push shows `Pushed` but Salesforce unchanged | Open the Workato job: the payload's `fields` keys are wire keys (`toSnake_` of the Salesforce label or alias) — the recipe's mapping must use the same keys. |
| Review sheets have no dropdowns | `_schema` empty or never refreshed — run `refreshSchema()` or Settings → Refresh now. |
| Settings → "N labels not in Salesforce" | Those `output_fields` lines need `=> Salesforce label`. |
| Dashboard "Not loaded" / "Limited view" | Runs as the deployer; the banner names which source that account cannot open. |
| "Copied (not moved)" log lines | The runner does not own the original (My Drive). Harmless; the copy is processed and the original is marked `g2s_claimed`. Move the folders to a shared drive to stop it. |

---

A full contract for every entry point, Config key, tab layout, payload, and gate rule is in the companion reference *gemini-to-salesforce — behavior and data contracts*.
