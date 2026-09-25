Seven recipes, split by three tests: can it be retried on its own, is it reused by more than one caller, and does it deserve its own job history. Everything is keyed by `workspace_id`; each recipe resolves the target from the workspace's row (data center, token from `RTR_Secrets`, folder id, label) rather than passing the token around, which keeps the number of steps that carry it to one lookup per recipe plus the connector steps.

**SPN-00 — Spin-up endpoint** (API endpoint, `POST /spinup`)
Validates the payload (`workspace_id`, `mode` ∈ initial | update | resume, `correlation_id`), checks the token row exists and the registry state permits the mode, writes a queue row, responds 202 with the correlation id. Nothing else. Endpoint recipes need to answer in seconds; a build alone takes minutes, so this recipe never touches the Developer API. Rejections (409 no token, 409 wrong state) are the only branching it has.

**SPN-01 — Orchestrator** (trigger: new row in `RTR_SpinupQueue`)
Pure sequencing and state. Reads the row, then by mode:
- initial: SPN-10 → SPN-11 → SPN-12 → gate → SPN-14 start
- update: SPN-10 (skipped if the row carries a `package_id`) → SPN-14 stop → SPN-11 → SPN-12 → gate → SPN-14 start
- resume: gate → SPN-14 start

The gate is one inline `list_connections` on the target folder, branching on `all_authorized`. State writes live only here: `deploying` → `configuring` → `awaiting_authorization` | `starting` → `active`, and `spinup_failed` with the step name and message from an error monitor around the whole sequence. Because everything downstream is idempotent, "retry" is re-inserting the row.

**SPN-02 — Fan-out** (manual, scheduled, or `POST /deploy-all`)
Calls SPN-10 once, then inserts one queue row per active workspace with `mode = update` and the `package_id`. This is the "golden changed, roll it out" recipe, and it's why build and import are separate functions: build once, import N times. Import is 500/hour and everything else 60/minute, so five workspaces is nowhere near a limit, but this is also where you'd throttle if N grows.

**SPN-10 — Build golden package** (recipe function)
In: nothing (golden is the registered environment). Steps: `upsert_manifest` (id from the `sdc_golden_manifest_id` property, `auto_generate_assets` Yes, `include_tags` Yes) → `build_and_download` as the wait. Out: `{ok, package_id, manifest_id, built_at, error}`. Separate because it's reused by SPN-01 and SPN-02 and because a build failure needs no target-side cleanup.

**SPN-11 — Import package to target** (recipe function)
In: `workspace_id`, `package_id`. Steps: resolve target → `lookup_folder_by_path` for the SDC project, `create_folder` if absent → write `folder_id` back to the workspace row → `deploy_package` (RLCM, source golden, runtime target, `restart_recipes` No, `include_tags` Yes). Out: `{ok, folder_id, recipe_status[], all_recipes_ok, error}`. With restart off, any `import_result` other than `no_update_or_updated_without_restart` is a failure, and it's caught here. Writing `folder_id` back is what lets every later recipe resolve the target from `workspace_id` alone.

**SPN-12 — Configure target** (recipe function)
In: `workspace_id`, `reauthorize` (default No). Steps: resolve target → `authorize_google_connections` → *repeat for each* shell of your own connectors needing the workspace token (`list_connections` → `pending`, filtered on `application`) → `update_connection` with `input_json` → `upsert_properties` for the per-workspace values that overwrite what traveled from golden. Out: `{ok, authorized[], pending[], error}`. Separate for one specific reason: with `reauthorize` Yes and a loop over active workspaces, this recipe alone *is* the SA key rotation procedure.

**SPN-14 — Set recipe state in order** (recipe function)
In: `workspace_id`, `action` (start | stop), `order` (the Orderer's list of recipe names, or omit to use the stored one). Steps: resolve target → `list_recipes` on the folder → name→id map → *repeat for each* over the list, reversed for stop → `manage_recipe`, skipping recipes already in the requested state → `list_recipes` again to verify. Out: `{ok, changed[], skipped[], failed[]}`. This is the Watchdog's stop/start pass pointed at a runtime target from the router — the Watchdog itself lives inside the estate and can't start itself. Callers after callables on start, reversed on stop.

**How the pieces compose**

- *Initial spin-up:* workbook → SPN-00 → row → SPN-01 → 10, 11, 12, gate, 14. If the gate fails, state is `awaiting_authorization` with the pending names; the human authorizes what's left; workbook → SPN-00 with `mode = resume` → SPN-01 runs gate + 14 only.
- *Golden release:* SPN-02 → one row per workspace → SPN-01 in update mode, build skipped.
- *Key rotation:* loop over active workspaces → SPN-12 with `reauthorize` Yes. No build, no import, no restart.

**Conventions worth holding to across all seven**

- Every function returns your `{ok, error{code, message}, …}` envelope; SPN-01 branches on `ok` and copies `error` into the state row verbatim. `correlation_id` rides on every call.
- Data masking on: the `RTR_Secrets` lookup step and every Dev API step in each function. It's one toggle per step, and the count is small precisely because the token is resolved inside each function.
- Nothing in SPN-11/12/14 checks registry state — only SPN-00 and SPN-01 do. Functions assume the caller has already decided the action is allowed, which is what makes them safe to run by hand from a test recipe.

If you want fewer than seven: SPN-02 can wait until you have a second release to roll out, and the gate could become an `SPN-13` function later if the workbook wants a `/spinup/status` endpoint. The other five are the minimum that keeps retry and reuse clean.
