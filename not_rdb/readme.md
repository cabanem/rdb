# Contract Intake (app_gemini-to-salesforce)

Config-driven contract intake for Google Workspace: a contract dropped into a Drive folder is read by Gemini, its terms are laid out on a per-contract review Sheet, a person corrects and approves them, and the approved values are pushed to Salesforce through a Workato API endpoint. A web-app dashboard shows where every contract is and is the place to add new ones.

One Apps Script project, bound to a Config spreadsheet. No code runs inside the review sheets; approval is a checkbox the poller reads.

```
Drive: Intake ──processIngestion (5 min)──▶ Gemini ──▶ review Sheet in Pending ──▶ Chat card
                                                                │
                                              reviewer corrects Approved column, ticks Approved?
                                                                │
                 processApprovals (5 min) ──▶ Gate (typed against Salesforce schema) ──▶ Workato ──▶ Salesforce
                                                                │
                                            sheet → Pushed (or stays in Pending with Status: Error)
```

A full description of every entry point, Config key, tab layout, payload, and gate rule is in the companion reference *gemini-to-salesforce — behavior and data contracts*. This file is the setup and operations guide.

---

## Files

| File | Role |
|---|---|
| `ContractIntake.js` | The two pollers, extraction, review-sheet read/write, Config parsing, Chat notifier, `setupTriggers()` |
| `Schema.js` | Fetches the Salesforce field schema from Workato, caches it in the `_schema` tab, loads it per run |
| `Gate.js` | Types and validates the Approved column against the cached schema before a push |
| `ReviewSheet.js` | Plans and applies the Approved column's dropdowns, checkboxes, date pickers, and highlights |
| `WorkatoPush.js` | POST to Workato with the Auth Token header; error-text shaping |
| `Intake.js` | Dashboard upload and Drive-picker adapters → Intake folder |
| `Claim.js` | Takes custody of an original (move, or copy + mark when Drive refuses the move) |
| `Access.js` | Folder capability preflight (`checkAccess`, `assertFolderAccess_`) |
| `Snapshot.js` / `Logging.js` | The `_queue` and `_logs` tabs |
| `WebApp.js` | `doGet()` and `getDashboardData()` |
| `ConfigEditor.js` / `ConfigTools.js` | Settings drawer endpoints; sheet menu and `_models` refresh |
| `Dashboard.html` | The dashboard page (single file, no framework) |
| `Tests.js` / `WorkatoTests.js` | Hermetic unit tests; live endpoint probes |
| `appsscript.json` | Scopes, Advanced Drive v3, DrivePicker library, web-app settings |

---

## Prerequisites

- **A Config spreadsheet** this project is bound to (or referenced by Script Property `CONFIG_SHEET_ID`), with a `Config` tab of `key | value` rows. The script creates `_logs`, `_queue`, `_schema`, and `_models` itself.
- **Six Drive folders** — Intake, Processed, Failed, Pending, Pushed, Cancelled — ideally in one shared drive where the runner is Content Manager. My Drive folders work if the runner has Editor, but a file the runner does not own is copied rather than moved (see Claim.js).
- **A GCP project with the Vertex AI API enabled** and the runner granted a Vertex user role. This is the project named in Config `project_id`, not the script's own sandboxed Cloud project; the script authenticates with the runner's OAuth token (`cloud-platform` scope).
- **Workato**: an API endpoint for the push (recipe upserts on `correlation_id`) and one for `/fetch-schema`, both behind an access profile using the native Auth Token method. The token goes in Script Property `WORKATO_WEBHOOK_SECRET`.
- Optional: a Google Chat incoming webhook; the DrivePicker helper web app (`lib_drive-picker`) deployed, for "Add from Drive".
- Tooling: `clasp` logged in as the account that will own the triggers and the deployment.

---

## Setup (once)

1. **Push the code.** `clasp push` from the project folder (`.clasp.json` carries the script id; `.js`, `.html`, `.json` are pushed).

2. **Fill the Config tab.** Required keys:

   | Key | Value |
   |---|---|
   | `folder_id_ingestion`, `folder_id_processed`, `folder_id_failed`, `folder_id_pending`, `folder_id_pushed`, `folder_id_cancelled` | Drive folder ids |
   | `prompt_template` | The extraction prompt. The `[[Label]]` format instruction is appended automatically. |
   | `output_fields` | One field per line, in review-sheet order. Write `Label => Salesforce label` when the friendly label differs from the Salesforce field label; the wire key is derived from the right-hand side. |
   | `project_id` | GCP project for Vertex |
   | `workato_webhook_url` | Push endpoint URL |
   | `workato_schema_url` | Schema endpoint URL, without query string |

   Commonly set optional keys: `model` (default `gemini-2.5-pro`), `location` (default `global`), `chat_webhook_url`, `upload_allowed_emails`, `config_allowed_emails`, `picker_url`, `guide_url`, `support_contact`. The full key list with types and defaults is in the contracts reference.

3. **Set Script Properties** (Project Settings → Script Properties): `WORKATO_WEBHOOK_SECRET` = the Workato Auth Token. Optionally `CONFIG_SHEET_ID` and `WORKATO_TEST_URL`.

4. **Authorize.** Run `validateConfig()` from the editor as the runner account and accept the OAuth prompt. It logs the parsed field list with wire keys, or names the missing key.

5. **Check folder access.** Run `checkAccess()`. Every folder should print `OK`; a `FAIL` line names the folder and the missing capability. Fix sharing before going further — the pollers run this same check and refuse to start on a failure.

6. **Cache the Salesforce schema.** Run `refreshSchema()`. It writes `_schema` and logs any `output_fields` labels that do not join to a Salesforce field; add `=> Salesforce label` aliases for those. Until this has run once, review sheets have no dropdowns and the gate passes everything through.

7. **Install the triggers.** Run `setupTriggers()`. It installs `processIngestion` and `processApprovals` every 5 minutes and `refreshSchema` daily at 06:00 (script time zone), replacing any earlier copies. **The account that runs this owns the pipeline's identity.**

8. **Deploy the dashboard.** Deploy → New deployment → Web app → *Execute as: Me*, *Who has access: Anyone within the org* (pre-filled from `appsscript.json`). Copy the `/exec` URL. Run `processApprovals()` once by hand so `_queue` exists and has a heartbeat before anyone opens the page.

9. **Optional — Drive picker.** Deploy the DrivePicker helper as its own web app and put its `/exec` URL in Config `picker_url`. The API key and project number live in that project's Script Properties, not here.

---

## Running it day to day

- **Submitting.** Drop a PDF, `.docx`, or `.doc` (≤ 15 MB) or a Google Doc into Intake — from Drive directly, the dashboard drop zone, or "Add from Drive". Within one poll the review sheet appears in Pending, the queue, and Chat.
- **Reviewing.** Open the review sheet, correct the **Approved** column (yellow cells need a choice; hover for the reason), tick **Approved?**. Tick **Cancel?** instead to withdraw. The next approvals poll validates every cell against the schema; a failure leaves the sheet in Pending with `Status: Error` and a `Last error` naming every bad cell.
- **Watching.** The dashboard's two heartbeat pills go `Stale` after three missed polls (15 min). `_logs` has the audit trail; the Errors list shows each distinct failure once, the queue row keeps showing it.
- **Changing settings.** Use the dashboard Settings drawer (validates with the same parser the pollers use, refuses stale saves). Locked keys — `project_id`, `location`, the Workato URLs — are changed in the sheet directly. Changes apply from the next poll.

---

## Updating the code

| You changed | Do |
|---|---|
| Any `.js` used by the pollers or menu | `clasp push` — triggers run the latest code immediately |
| `Dashboard.html`, `WebApp.js`, `Intake.js`, `ConfigEditor.js`, `Schema.js` (anything the page calls) | `clasp push`, then Deploy → Manage deployments → edit → *New version* → Deploy. The URL does not change. Or `clasp deploy -i <deploymentId>`. |
| `appsscript.json` scopes | `clasp push`, then re-run any function as the runner to re-authorize; redeploy the web app |
| `output_fields` or the prompt | Config only; takes effect for contracts extracted after the save |

---

## Testing

- `runTests()` — 115 hermetic cases over the pure functions (parsing, config coercion, sheet read-back against a fake sheet, snapshot, upload checks, schema shaping, gate rules, review-sheet planning). No network, no Drive. Results in the execution log.
- `probeApiToken()` — one POST to the push URL; 200 / 400 / 401 tells you whether the token and the recipe's validation are in play.
- `runWorkatoTests()` — five live scenarios against `WORKATO_TEST_URL` (falls back to the production URL). **Two of them upsert a Salesforce record** with `correlation_id` `TEST-<ms>`; point the property at a test recipe or set `RUN_SF_PATH = false` first.

---

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

## Identity, in one paragraph

Everything runs as one account: the one that ran `setupTriggers()` and deployed the web app. Its Drive permissions, Vertex role, and Apps Script quota are the pipeline's. Dashboard visitors are identified only by email for the two allow-lists and for provenance; the only action taken with a visitor's own credentials is the Drive-picker download. Re-running `setupTriggers()` or redeploying as a different account silently changes all of this.
