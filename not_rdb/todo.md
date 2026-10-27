# gemini-to-salesforce — refactor & Vertex identity TODO

Rules for every task: no behavior change unless the task says so; `runTests()` must stay green; each phase ends deployable (`clasp push`, run tests, 3 contracts end to end: PDF, Google Doc, Word; one cancel; one push).
Dependency rule: definitions ← adapters ← pipeline ← entrypoints. Calls go down (or sideways within adapters), never up. No Drive/Sheets/Docs calls in `adapters/Extractor.gs`.
Trigger handler names (`processIngestion`, `processApprovals`, `refreshSchema`) must not change.

## Phase 1 — reorganize (no behavior change)

- [ ] Normalize line endings to LF; delete the duplicate `debugPicker` (keep the Tests.js one).
- [ ] Remove dead code: `signPush_`, `createInPlace_`, `schemaFetchedAt_`, Config key `workato_shared_secret` (parseConfig_, typedef), sheet menu (`onOpen`, `validateConfigUi`, `checkAccessUi`).
- [ ] Create folders `definitions/ adapters/ pipeline/ entrypoints/ tests/` and move functions per the map below. Rename files only; rename functions only where listed.
- [ ] `definitions/Config.gs`: Config typedef, `getConfigSpreadsheet_`, `readConfig_`, `getConfigSheet_`, `readConfigRaw_`, `parseConfig_`, `parseOutputFields_`, `str_`, `isFilled_`, `asBool_`, `parseList_`, `toSnake_`, `wireKey_`, `rekey_`, `validateConfig`, plus `CONFIG_SCHEMA` and `LOCKED_KEYS` from ConfigEditor.
- [ ] `definitions/Schema.gs`: Schema typedefs/constants, `schemaRows_`, `reconcileSchema_`, `schemaFromRows_`, `schemaFor_`, `isPicklist_`, `num_`, plus the per-cell normalization core from Gate: `normalizeValue_` and all `normalize*_`, `matchOption_`, `optionList_`, `toDate_`, `ok_`, `fail_`, `isBlank_`, `fold_`, `GATE_*` constants.
- [ ] `definitions/Prompts.gs`: `fieldInstruction_`, `parseResult_`, `escapeRegex_`.
- [ ] `adapters/Extractor.gs`: `callGemini_`, `interpretGeminiResponse_`, `extractSources_`, and from ConfigTools `listPublisherModels_`, `parseModelList_`, `dedupeModels_`, `MODEL_EXCLUDE`, `MODELS_MAX_PAGES`.
- [ ] `adapters/Drive.gs`: `buildExtractionParts_` → rename `readContractDoc_`, `wordToText_`, `moveFile_`, `driveUrl_`, `INLINE_PDF_MAX_BYTES`, all of Claim.js, all of Access.js (fix its header: shared-drive invariant is no longer the direction), `stageBlob_`, `recordIntake_`, `intakeDescription_`, `intakeMessage_`, `countIntakeFiles_`, `folderExists_`.
- [ ] `adapters/ReviewSheet.gs`: current ReviewSheet.js + `createReviewSheet_`, `readApproval_`, `readMeta_`, `setMeta_`, `sameLabel_`, `markPushed_/markCancelled_/markPending_/markError_`, `repointSheet_`, `META`, `GRID_HEADER`, `REVIEW_SHEET_TAB`.
- [ ] `adapters/Workato.gs`: WorkatoPush.js (minus `signPush_`) + `fetchSchema_`, `interpretSchemaResponse_`.
- [ ] `adapters/Logging.gs`, `adapters/Snapshot.gs`: unchanged. `adapters/Chat.gs`: `ChatNotifier`, `notifyReview_`. `adapters/SchemaCache.gs`: `loadSchema_`, `writeSchemaTab_`, `schemaStatus_`, `SCHEMA_SHEET_NAME`, `SCHEMA_HEADER_ROW`, `SCHEMA_META`.
- [ ] `pipeline/Intake.gs`: body of `processIngestion` as `runIngestion_()`, `extractOneFile_`.
- [ ] `pipeline/Gate.gs`: `validateApproval_`, `checkDependent_` only.
- [ ] `pipeline/Push.gs`: body of `processApprovals` as `runApprovals_()`, `nextAction_`, `buildPayload_`, `refreshSchema` orchestration as `runSchemaRefresh_()`.
- [ ] `entrypoints/Triggers.gs`: `setupTriggers`, `setupSchemaTrigger`, `POLL_MINUTES`, and `processIngestion/processApprovals/refreshSchema` as one-line delegates.
- [ ] `entrypoints/Upload.gs`: `uploadContract`, `importPicked`, `validateUpload_`, `assertUploadAllowed_`, `uploaderEmail_`, `mb_`, `UPLOAD_TYPES`, `PICKER_MIME_TYPES`. Delete the old Intake.js.
- [ ] `entrypoints/WebApp.gs`, `entrypoints/ConfigEditor.gs` (+ `refreshSchemaFromDashboard`), `entrypoints/ConfigTools.gs` (`refreshModelList`, `configValueCell_`, `MODELS_*`): keep, minus what moved.
- [ ] `tests/Tests.gs`, `tests/WorkatoTests.gs`: update any moved references; add a test asserting no file in `adapters/Extractor.gs` references `DriveApp|Drive\.|SpreadsheetApp|DocumentApp` (grep in a Node script or document as a manual check).
- [ ] Move the ARCHITECTURE/BINDING/SETUP header prose from ContractIntake.gs and the DEPLOY prose from WebApp.gs into `README.md`; leave one-paragraph headers per file.
- [ ] CHECKPOINT 1: push, tests, end-to-end run.

## Phase 2 — the extractor seam

- [ ] Mint `correlation_id` at the top of the per-file loop in `runIngestion_` (`Utilities.getUuid()`); pass it to `extractOneFile_`, `extractContract_`, `createReviewSheet_` (remove the mint there), and to `logError_` in the extract-failure catch.
- [ ] `extractContract_(doc, cfg, corr, deps)` → `{fields, raw:{text, sources, debug}, meta:{model, location, correlation_id}}`. `deps` defaults to `{getToken: extractor_getToken_, send: extractor_send_}`. `Intake` calls only this.
- [ ] Split `callGemini_` into: `extractor_buildRequest_(doc, cfg, prompt)` (pure; `{url, body, headers}` without Authorization; turns `doc` into `parts`; no quota header — the spike's Vertex calls succeeded without it under both tokens), `extractor_getToken_(cfg)` (returns `ScriptApp.getOAuthToken()` for now), `extractor_send_(req, token, corr)` (the only `UrlFetchApp` in the file; adds `Authorization` and `X-Correlation-Id`), `extractor_interpret_` (= today's `interpretGeminiResponse_`, renamed, keep old name as alias until tests move).
- [ ] `readContractDoc_(file)` returns `{name, mimeType, text}` or `{name, mimeType, bytes}`; size cap stays here. Word conversion stays here.
- [ ] `listPublisherModels_` uses `extractor_getToken_(cfg)`.
- [ ] Error shape: in `adapters/Logging.gs` add `pipelineError_(stage, status, message, corr, retryable)` → `Error` with those props, and `errorShape_(err)` → `{stage, status, retryable, message, correlation_id}` (classify by Google's `error.details[].reason` — `SERVICE_DISABLED`, `USER_PROJECT_DENIED`, `IAM_PERMISSION_DENIED` — before any regex; regex fallback = today's `classifyError_`). Stages: `read | vertex_token | vertex | parse | sheet | gate | workato`.
- [ ] Throw `pipelineError_` from `extractor_send_`/`extractor_interpret_` (stage `vertex`), `readContractDoc_` (`read`), `validateApproval_` caller (`gate`), `pushToWorkato_` (`workato`, status = HTTP code, retryable = 429/5xx).
- [ ] Consume it: `markError_`, `queueRow_`, `logError_` details (include stage/status), `classifyError_` prefers `err.stage/retryable` when present.
- [ ] Opt-in behavior change (do last, separately): in `runIngestion_`, if `errorShape_(err).retryable`, leave the file in Intake and log WARN instead of moving to Failed.
- [ ] CHECKPOINT 2.

## Phase 3 — tests

- [ ] `tests/Fixtures.gs`: one real `generateContent` response (contract text redacted) as `FIXTURE_VERTEX_OK`; one 429 and one SAFETY response.
- [ ] Tests: `extractor_buildRequest_` shape (PDF inline vs text; grounding on/off; system instruction; no quota header), `extractor_interpret_` against each fixture, `extractContract_` with `deps` stubbed (`send` returns fixture, `getToken` returns `'t'`), `errorShape_` on a `pipelineError_` and on a plain `Error`.
- [ ] Register in `runTests()`.

## Phase 5 — service-account identity (spike verdict B: impersonation works, mint call needs `x-goog-user-project`)

- [ ] Config keys `vertex_auth` (`runner` | `impersonate`; empty → `runner`) and `vertex_sa_email`: `parseConfig_`, Config typedef, `LOCKED_KEYS`, `CONFIG_SCHEMA` Model group. Validation: `impersonate` requires `vertex_sa_email`.
- [ ] `extractor_getToken_(cfg)`: `impersonate` branch POSTs `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<sa>:generateAccessToken` with the runner token, body `{scope:["https://www.googleapis.com/auth/cloud-platform"], lifetime:"3600s"}`, header `x-goog-user-project: cfg.project_id` on the mint call (required; the Vertex call itself needs no header); cache in `CacheService.getScriptCache()` key `vertex_token:<sa>` TTL 3300 s; failure throws stage `vertex_token`.
- [ ] On a 401 from Vertex with `impersonate`: evict cache, re-mint once, then fail.
- [ ] Tests: token branch selection with a stubbed minter; mint request shape (URL, header present, scope = cloud-platform only); cache hit/miss; a `USER_PROJECT_DENIED` / `IAM_PERMISSION_DENIED` mint body maps to stage `vertex_token` with that reason in the message.
- [ ] CHECKPOINT 3: flip one contract via Config; confirm SA in Vertex audit log; force a mint failure and confirm `_logs` shows stage `vertex_token`.

## Phase 7 — docs (code-adjacent)

- [ ] Update contracts doc: seam interface, error shape, Config identity block, execution vs actor identity. Record the two grants any runner needs (`roles/iam.serviceAccountTokenCreator` on the SA, `roles/serviceusage.serviceUsageConsumer` on the Vertex project), the mint header, and the Cloud Logging queries (Vertex `principalEmail` = SA, `serviceAccountDelegationInfo` = runner).
- [ ] User guide: schema-driven review sheet (dropdowns, highlighted cells, `;` for multipicklist).
- [ ] Optional: `approved_by` column filled by the poller from the sheet's revision history at push time.

## Not Claude Code (human)

Phase 0 manager replies · Phase 4 done (spike = B) · Phase 6 bot account licensing and ownership transfer (grant the bot Token Creator on the SA and serviceUsageConsumer on the Vertex project, then remove both from you; re-run `setupTriggers` as the bot; add yourself to `config_allowed_emails`; verify `/exec` URL, `guide_url`, Chat pin, `PICKER_ALLOWED_ORIGINS`).
