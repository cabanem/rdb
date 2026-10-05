# SDC routing — one registry, 2026-10-04

Supersedes the 24 Sep pick-up notes. Decision taken today: **RTR_Pool is the registry.** The Google Sheet `registry` tab goes away as a store (it survives as a read-only view in the routing workbook), `Route` reads only data tables, and the routing workbook is a client of the router's lifecycle endpoints.

## 1. What travels where

| Fact | Lives in | Written by |
|---|---|---|
| workspace exists, deployed, `api_base_url`, `api_collection_id` | RTR_Pool | POOL-01 (prepare/register) |
| client API token, dev API token | RTR_Secrets | POOL-01 / ops |
| `spreadsheet_id` → `workspace_key` binding, `client_name`, `bound_at`, `activated_at`, `closed_at` | RTR_Pool (new columns) | claim / router / close |
| router URL + token, `meta.workspace_key` | the config workbook's `_developer_settings` | routing workbook on claim (`Registry.applyToWorkbook`) |

Nothing per-workspace reaches a config workbook. The router resolves the target from `spreadsheet_id`; the workbook only needs the router.

One `state` column on RTR_Pool, one chain:

```
empty → queued → deploying → configuring → needs_connections → registering → available
      → bound → active → inactive        (failed is a side state; inactive → empty is POOL-15 clean, later)
```

Writers: POOL-01 owns everything up to `available`; `/workspaces/claim` writes `bound`; `Route` writes `active` (first successful `/provision`); `/workspaces/{key}/close` writes `inactive`; `/workspaces/{key}/release` returns `bound` or `inactive` to `available`.

## 2. Transport: one shape for every call

Library 1.9.0 makes every workbook → Workato call

```
POST <router.baseUrl>/route     API-TOKEN: <router.apiToken>
{ spreadsheet_id, correlation_id, path, is_initial, payload: "<json string>", payload_version }
→ 200 { status_code, body }
```

`Webhook.call(config, route, payload, options)` builds the envelope, unwraps the answer, and hands callers exactly what they used to get from the workspace directly. Validate and preview stop being GETs: they go through the same POST envelope, which means **API-01 and API-02 on golden switch to POST** (one edit each in the endpoint settings; the trigger fields are unchanged). That removes the router-side GET clones (2.3/2.4) from the plan entirely.

Paths the router knows, and which states may call them:

| path | bound | active |
|---|---|---|
| `/provision` | only `is_initial=true` (→ activate) | only `is_initial=false` |
| `/validate_configuration`, `/preview-template_file` | yes | yes |
| `/invitations`, `/portal-invite` | NOT_PROVISIONED | yes |

## 3. Files in this delivery

`lib_sdc/` — replace these files in lib_sdc (cut against 1.8.0; everything else untouched):

| File | Change |
|---|---|
| `000_Config.js` | `webhook` block → `router: {baseUrl, apiToken, workspaceKey}` |
| `009_Webhook.js` | rewritten: router envelope, unwrap, `tolerateErrorStatus`, transport vs endpoint errors |
| `005_Preflight.js` | webhook-URL check → `Webhook._requireRouter(config)`; `options.webhookUrl/Label` gone |
| `005_Provision.js` | call site: `route: {path:'/provision', isInitial}` |
| `007_Validate.js`, `010_Preview.js` | `_call` GET helpers deleted; `Webhook.call` with `tolerateErrorStatus:true` |
| `004_Invitations.js` | send-all contract (`excludeSupplierRequestIds`, default empty) through `/invitations` |
| `004_Portal.js` | own correlation ID, `/portal-invite`; `_script_logs` recovery dropped |
| `002_Migrations.js` | step 1.7 → 1.8: adds `router.baseUrl`, `router.apiToken` (seeded from `webhook.apiPlatformToken`), `meta.workspace_key` |
| `008_Version.js` | 1.9.0 / payload 10.0 / schema 1.8 |
| `013_Registry.js` | **new**: lifecycle-endpoint client + `applyToWorkbook` |

`app_sdc-router/` — new container-bound app for the routing workbook (`main.js`, `appsscript.json`). Menu: Claim workspace…, Refresh registry, Close engagement…, Release workspace…, and an ops submenu (Prepare, Register, Check). Claim = prompt client → prompt existing workbook or generate from template → `Registry.claim` → `Registry.applyToWorkbook` (+ migrate the target if needed) → on write failure, release the claim.

`app_sdc-shim/sendAllInvitations.js` — drop-in for the shim's hardcoded-webhook `sendAllInvitations()`, plus the `showInvitationResults_` renderer the shim called but never defined. `sendInvitations()` and `readSelectedSupplierRequestIds_()` can go.

`workato/route_decision.py` — `Route` step 2.

## 4. Workato edits (router workspace, BASE)

### 4.1 RTR_Pool

Add columns: `spreadsheet_id` (short), `client_name` (short), `workbook_url` (short), `bound_at`, `activated_at`, `closed_at` (date-time). Update the `state` hint to the chain in §1.

### 4.2 `Route` (recipe function) — rebuild the body

Trigger unchanged (`spreadsheet_id, correlation_id, path, is_initial, payload` → `status_code, body`). Delete every step and build:

```
1  Data table · Get records      RTR_Pool, spreadsheet_id = ‹trigger › spreadsheet_id›, limit 1
2  Python · Execute code         route_decision.py
                                  inputs: rows (list ← step 1 records: workspace_key, state, api_base_url,
                                          client_name, closed_at), path ← trigger, is_initial ← trigger
                                  outputs: action, activate (bool), target_key, target_base_url, http_status (int), body_json
3  IF ‹2 › action› = reject
   3a Return result              status_code = ‹2 › http_status›, body = ‹2 › body_json›
4  Data table · Get records      RTR_Secrets, workspace_key = ‹2 › target_key›, limit 1
5  IF ‹4 › records› is empty
   5a Return result              500, {"error_details":{"code":"NO_CREDENTIALS","error_message":"No API token is
                                  registered for the target workspace. Register it from the routing workbook.",
                                  "errored_action":"router"}}
6  HTTP · Send request           POST  =‹2 › target_base_url› + ‹trigger › path›
                                  headers: Content-Type: application/json, API-TOKEN: ‹4 › api_token›   (hyphen!)
                                  body: ‹trigger › payload›   (raw string, not re-serialised)
                                  response type: raw/text · do NOT raise on HTTP errors · disable retries
                                  completion threshold: measure one E1 and set it; see §7
7  IF ‹2 › activate› is true AND ‹6 › status code› = 200
   7a Data table · Update record RTR_Pool, record id = ‹1 › records › Record ID›
                                  state = active, activated_at = now, last_correlation_id = ‹trigger › correlation_id›
8  Return result                 status_code = ‹6 › status code›, body = ‹6 › body›
```

Output-schema sample for step 2: `{"action":"forward","activate":true,"target_key":"sdc-07","target_base_url":"https://…","http_status":0,"body_json":""}`. Remove the Google Sheets app from the recipe's connections once the steps are gone.

### 4.3 `RTR-API`

Step 3 (Return 200): `status_code` = `‹Route › status_code›` instead of the literal 200. Nothing else.

### 4.4 Four new endpoint recipes on the **Workspace lifecycle** collection

All native steps, all keyed on RTR_Pool, same error envelope as POOL-API-01/02/03, same try/catch → 400 shape. Run **POOL-API-05 at concurrency 1** (that is the claim lock).

| Recipe | Endpoint | Steps |
|---|---|---|
| POOL-API-04 | `GET /workspaces` | Get records RTR_Pool (no filter, order by workspace_key) → 200 `{workspaces: [...]}` using list mapping on the records pill; project `workspace_key, state, client_name, spreadsheet_id, workbook_url, bound_at, activated_at, closed_at, api_base_url, last_error, pending_connections, updated_at` |
| POOL-API-05 | `POST /workspaces/claim` `{client_name, spreadsheet_id, workbook_url, correlation_id}` | (a) Get records `spreadsheet_id = request` limit 1 → if found and state in bound/active: 409 `ALREADY_BOUND` (message carries the existing workspace_key). (b) Get records `state = available` limit 1 → if empty: 409 `NO_CAPACITY`. (c) Update that record: `state=bound, spreadsheet_id, client_name, workbook_url, bound_at=now, last_correlation_id`. (d) 200 `{workspace_key, state:"bound", client_name, spreadsheet_id}` |
| POOL-API-06 | `POST /workspaces/{workspace_key}/release` `{correlation_id}` | Get by key → 404 `NOT_FOUND`; state ∉ {bound, inactive} → 409 `INVALID_STATE`. Update: `state=available`, clear `spreadsheet_id, client_name, workbook_url, bound_at, activated_at, closed_at, last_error`. 200 `{workspace_key, state:"available"}` |
| POOL-API-07 | `POST /workspaces/{workspace_key}/close` `{correlation_id}` | Get by key → 404; state ≠ active → 409 `INVALID_STATE`. Update: `state=inactive, closed_at=now`. 200 `{workspace_key, state:"inactive", closed_at}` |

Reuse POOL-API-02's `WorkspaceKeyPath` path-param definition for 06/07.

### 4.5 POOL-13

`api_collection_ids` currently binds the new API client to **every** collection in the target (`collections.pluck(:id)`); change it to `‹match › id›` so the client sees the one collection `api_base_url` points at.

## 5. Golden edits (Randstad DataBridge)

1. **`/health`** — new one-step API recipe on *Provisioning (GAS)*: `GET health` → 200 `{ok: true}`. POOL-01 step 56 calls it; without it no workspace reaches `available`.
2. **`/invitations`** — move from the stray "Route" collection to *Provisioning (GAS)*, method **POST**, bound to R-1 (POST). Delete the golden "Route" collection afterwards so the manifest carries one collection.
3. **API-01 `preview-template_file`, API-02 `validate_configuration`** — method GET → **POST**. Trigger schemas unchanged (the library sends the same fields in the body; `payload_version` is on the payload).
4. **`/portal-invite`** — still to build (POST, *Provisioning (GAS)*). Until it exists the router relays golden's 404 and the analyst sees it as "HTTP 404 from /portal-invite".
5. Retire the R-1 webhook recipe once the POST path is proven.

Re-export golden after 1–3; the pool imports from the manifest.

## 6. Routing workbook setup

1. New Sheet. Tabs `_settings` (4 columns, `_developer_settings` convention) and `registry` (left empty; refresh fills it). `_script_logs` is created on first open.
2. `_settings` rows — category/key/value:
   `router.baseUrl` = Route collection base URL (…/router-v1) · `router.lifecycleBaseUrl` = Workspace lifecycle collection base URL (…/workspace_lifecycles) · `router.apiToken` · `template.workbookId` (a config workbook template already at schema 1.8, or claim will migrate each copy) · `template.destinationFolderId` · `workbook.integrationAccountEmail` · `workbook.configExportFolderId` (optional) · `workbook.authorizedEditors` (optional).
3. Grant the router API client **both** collections (Route and Workspace lifecycle); one token.
4. Paste `app_sdc-router/` as the container-bound script; add lib_sdc as `SDC`.

The old Sheet at `1Oc1sw…` is no longer read by anything.

## 7. Order of application and test

1. §4.1 columns, §4.2–4.3 Route/RTR-API, §5.1–5.3 golden (health, invitations, POST), then re-export golden.
2. Push lib_sdc 1.9.0; bump the shim's library version; paste `sendAllInvitations.js` into the shim.
3. §4.4 endpoints, §6 routing workbook.
4. **Test 6.1 by hand-binding** before the claim endpoint exists if you want: set one RTR_Pool row `state=bound`, `spreadsheet_id=<dev workbook>`, write `router.baseUrl`/`router.apiToken` into the dev workbook's `_developer_settings` (or run "Migrate workbook schema" there and fill the two blanks). Run Validate (bound → forwards), then Start supplier data collection (bound+initial → forwards, row flips to `active`), then Start again (ALREADY_PROVISIONED), then Update (active → forwards), then Send invitations.
5. Time the first E1 through the router. `/route` has `recipe_timeout: 240`; UrlFetchApp is told to wait 250 s. If E1 is longer, `/provision` needs the 202-and-poll shape — flag it before building more on the synchronous forward.
6. Claim end-to-end from the routing workbook: generate → bound → analyst runs Start → active. Then Close, Release, Refresh.

## 8. Open

- `/portal-invite` recipe on golden.
- POOL-15 clean (inactive → empty) replaces "release an inactive workspace" once built; until then release from `inactive` is ops asserting the purge.
- `webhook.*Url` rows in old workbooks are inert; delete them in a later migration once nothing is rolled back.
- BASE housekeeping: `revert_prior_provisioning_attempt` points at a recipe not in the export; `home_*`, `MAIN_ProvisioningResults`, `new_deployment`, `test` look like earlier iterations.
