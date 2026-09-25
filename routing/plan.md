Same notation as the handoff's `Route` listing. Every function returns the envelope `{ok, error{code, message}, …}`; `target` means the Dev API runtime override (`target_data_center = ‹RTR_Pool › data_center›`, `target_api_token = ‹RTR_Secrets › dev_api_token›`, `target_label = workspace_key`), and 🔒 marks steps to enable data masking on.

**POOL-10 · Build golden package**

```
Trigger  Recipe function              inputs: correlation_id
MONITOR
1   Dev API · Create or update manifest   env = GOLDEN, manifest_id = ‹Properties › sdc_golden_manifest_id›,
                                          folder_id = ‹Properties › sdc_golden_folder_id›,
                                          auto_generate_assets Yes, include_tags Yes, include_data No
2   Dev API · Build and download package  mode rlcm, env = GOLDEN, id = ‹1 › id›, download_content No
3   Return result                         ok = true, package_id = ‹2 › id›, manifest_id = ‹1 › id›, built_at = now
ON ERROR
E   Return result                         ok = false, error = {code: BUILD_FAILED, message: ‹error › message›}
```

Golden is a registered environment, so no override here. Build failures raise inside step 2 (the poll loop errors on `failed`), which is why the monitor is the whole body.

**POOL-11 · Import package**

```
Trigger  Recipe function              inputs: workspace_key, package_id, correlation_id
1   Data tables · Get record            RTR_Pool, workspace_key = ‹trigger›
2   Data tables · Get record            RTR_Secrets, workspace_key = ‹trigger›                          🔒
MONITOR
3   Dev API · Lookup folder by path     target, path = "SDC"                                             🔒
4   IF   ‹3 › found› is false
    4a  Dev API · Create folder         target, name = "SDC", no parent                                 🔒
5   Dev API · Deploy package            mode rlcm, id = ‹trigger › package_id›, source_environment = GOLDEN,
                                        target, folder_id = ‹4a › id›.presence || ‹3 › id›,
                                        restart_recipes No, include_tags Yes                             🔒
6   IF   ‹5 › all_recipes_ok› is false
    6a  Return result                   ok = false, error = {code: IMPORT_PARTIAL,
                                          message: ‹5 › recipe_status›.where(ok: false).pluck('id','import_result').to_json}
7   Data tables · Update record         RTR_Pool: folder_id = ‹4a › id›.presence || ‹3 › id›,
                                        package_id = ‹trigger › package_id›, deployed_at = now
8   Return result                       ok = true, folder_id, recipe_count = ‹5 › recipe_count›,
                                        recipe_status = ‹5 › recipe_status›
ON ERROR
E   Return result                       ok = false, error = {code: IMPORT_FAILED, message: ‹error › message›}
```

With restart off, every `import_result` should be `no_update_or_updated_without_restart`; step 6 is the trap for anything else. If step 5 comes back 422 asking for `folder_id_for_home_assets`, set it to the same folder id and it becomes a fixed input.

**POOL-12 · Configure target**

```
Trigger  Recipe function              inputs: workspace_key, reauthorize (default false), correlation_id
1   Data tables · Get record            RTR_Pool, workspace_key = ‹trigger›
2   Data tables · Get record            RTR_Secrets, workspace_key = ‹trigger›                          🔒
MONITOR
3   Dev API · Authorize Google connections
                                        target, folder_id = ‹1 › folder_id›,
                                        applications = google_drive,google_sheets, reauthorize = ‹trigger›  🔒
4   IF   ‹3 › all_ok› is false
    4a  Return result                   ok = false, error = {code: GOOGLE_AUTH_FAILED,
                                          message: ‹3 › results›.where(outcome: 'failed').pluck('name','error').to_json}
5   Dev API · List connections          target, folder_id = ‹1 › folder_id›                            🔒
6   REPEAT for each  ‹5 › pending›.where(application: '<your connector's application value>')
    6a  Dev API · Update connection     target, connection_id = ‹item › id›, shell_connection No,
                                        input_json = {"api_token":"‹2 › dev_api_token›"}   ← literal text + pill  🔒
7   Dev API · Upsert properties         target, [project_id = SDC project if these are project properties],
                                        sdc.workspace_key = ‹trigger›, sdc.router_base_url = ‹Properties › …›  🔒
8   Dev API · List connections          target, folder_id = ‹1 › folder_id›                            🔒
9   Return result                       ok = true, all_authorized = ‹8 › all_authorized›, pending = ‹8 › pending›
ON ERROR
E   Return result                       ok = false, error = {code: CONFIGURE_FAILED, message: ‹error › message›}
```

Step 6's filter value comes from reading step 5's output once on a real workspace — custom connectors report an `application` string you can't guess. Step 6a's `input_json` field is a plain text field, so the JSON is typed literally with the pill inside it; the key names are whatever that connector's connection fields are called. Step 8 is the truth after the writes; the orchestrator branches on it.

**POOL-13 · Register API client**

```
Trigger  Recipe function              inputs: workspace_key, correlation_id
1   Data tables · Get record            RTR_Pool, workspace_key = ‹trigger›
2   Data tables · Get record            RTR_Secrets, workspace_key = ‹trigger›                          🔒
MONITOR
3   Dev API · List API collections      target, name = ‹Properties › sdc_collection_name›                🔒
4   IF   ‹3 › match› is empty
    4a  Return result                   ok = false, error = {code: COLLECTION_MISSING,
                                          message: "Collection not found in target — check the golden manifest carries api_group"}
5   Dev API · Find or create API client target, name = "SDC Router — ‹trigger › workspace_key›",
                                        project_id = ‹3 › match › project_id›,
                                        api_collection_ids = [‹3 › match › id›]                        🔒
6   Dev API · List API keys             target, api_client_id = ‹5 › id›                                🔒
7   IF   ‹6 › keys›.where(name: 'router').present?
    7a  Dev API · Refresh API key secret  target, api_client_id = ‹5 › id›,
                                          api_key_id = ‹6 › keys›.where(name: 'router').first['id']     🔒
    ELSE
    7b  Dev API · Create API key        target, api_client_id = ‹5 › id›, name = "router", active Yes  🔒
8   Return result                       ok = true, api_client_id = ‹5 › id›,
                                        api_key_id = ‹7a › id›.presence || ‹7b › id›,
                                        api_token  = ‹7a › auth_token›.presence || ‹7b › auth_token›,
                                        api_collection_id = ‹3 › match › id›,
                                        api_base_url = ‹3 › match › url›                                 🔒
ON ERROR
E   Return result                       ok = false, error = {code: REGISTER_CLIENT_FAILED, message: ‹error › message›}
```

Step 7 is what makes rerun safe: the list endpoint returns a masked token, so an existing key is refreshed rather than duplicated. A rerun therefore rotates the token — the orchestrator must always write step 8's `api_token` to `RTR_Secrets`, never assume the old one still works.

**POOL-14 · Set recipe state in order**

```
Trigger  Recipe function              inputs: workspace_key, action (start | stop), correlation_id
1   Data tables · Get record            RTR_Pool, workspace_key = ‹trigger›
2   Data tables · Get record            RTR_Secrets, workspace_key = ‹trigger›                          🔒
3   Data tables · Search records        RTR_RecipeOrder, all rows, sort position asc
4   Dev API · List recipes              target, folder_id = ‹1 › folder_id›                            🔒
5   Python · Execute code               inputs: order (‹3 › records›), recipes (‹4 › recipes›), action
                                        → ordered_ids, missing, already_in_state
6   IF   ‹5 › missing› is not empty
    6a  Return result                   ok = false, error = {code: ORDER_MISMATCH, message: ‹5 › missing›.to_json}
MONITOR
7   Dev API · Set recipes state         target, recipe_ids = ‹5 › ordered_ids›, action = ‹trigger › action›  🔒
                                        (patch 3 long action; until then: REPEAT for each ‹5 › ordered_ids› → Manage recipe)
8   Dev API · List recipes              target, folder_id = ‹1 › folder_id›                            🔒
9   IF   ‹8 › recipes›.where(running: action == 'stop').present?
    9a  Return result                   ok = false, error = {code: STATE_MISMATCH,
                                          message: ‹8 › recipes›.where(running: action == 'stop').pluck('name').to_json}
10  Return result                       ok = true, changed = ‹7 › changed›, skipped = ‹5 › already_in_state›, failed = ‹7 › failed›
ON ERROR
E   Return result                       ok = false, error = {code: SET_STATE_FAILED, message: ‹error › message›}
```

Python for step 5:

```python
def main(input):
    action  = (input.get("action") or "start").strip().lower()
    want    = action == "start"                       # desired `running` value
    order   = sorted(input.get("order") or [], key=lambda r: int(r.get("position") or 0))
    by_name = {r["name"]: r for r in (input.get("recipes") or [])}

    ordered, missing, already = [], [], []
    for row in order:
        name = row.get("recipe_name")
        rec  = by_name.get(name)
        if rec is None:
            missing.append(name); continue
        if bool(rec.get("running")) == want:
            already.append(name); continue
        ordered.append(int(rec["id"]))

    # golden recipes absent from the order table are a mismatch too
    missing += [n for n in by_name if n not in {r.get("recipe_name") for r in order}]

    if not want:
        ordered.reverse()                              # stop in reverse topological order
    return {"ordered_ids": ordered, "missing": sorted(set(missing)), "already_in_state": already}
```

`missing` is fatal in both directions on purpose: a recipe in golden that isn't in `RTR_RecipeOrder` would otherwise silently never start. Adding a recipe to golden means adding a row to the order table, and this is the step that enforces it.

**Where endpoint enablement goes**

It isn't in any function. In POOL-01's register phase the order is:

```
POOL-13 → Update RTR_Secrets.api_token, RTR_Pool.api_base_url/api_client_id/api_key_id
        → POOL-14 start
        → Dev API · Set API endpoints state   target, api_collection_id = ‹POOL-13 › api_collection_id›, enable
        → HTTP · GET ‹api_base_url›/health  API-TOKEN = ‹POOL-13 › api_token›, expect 200
        → RTR_Pool.state = available
```

Enable has to follow start because Workato refuses to enable an endpoint whose recipe isn't running, and the health check has to follow enable for the same reason.
