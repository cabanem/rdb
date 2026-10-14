Yes. Same notation as before: `‹n›` is a datapill from step n, 🔒 means enable data masking on the step. `target` is shorthand for the connector's target fields mapped from the pool row — `target_kind = ‹1›target_kind`, `workato_environment = ‹1›target_environment`, `target_data_center = ‹1›data_center`, `target_api_token = ‹2›dev_api_token` 🔒, `target_label = workspace_key`. Every function's error block returns `{ok: false, error: {code, message}}` so POOL-01 only ever branches on `ok`.

**POOL-API-01 · Prepare** — `POST /workspaces/prepare`

```
Trigger  API Platform · New API request     {workspace_key, correlation_id, package_id?}
1   Data tables · Get record            RTR_Secrets, workspace_key
2   IF ‹1› not found                    → Return response 409 {error: NO_TOKEN}
3   Data tables · Get record            RTR_Pool, workspace_key
4   IF ‹3›state not in [empty, failed]  → Return response 409 {error: BAD_STATE, state}
5   Data tables · Insert record         RTR_PoolJobs {workspace_key, command = prepare, correlation_id,
                                        state = queued, package_id = ‹trigger›package_id}
6   Data tables · Update record         RTR_Pool: state = queued
7   Return response 202                 {job_id = ‹5›id, correlation_id}
```

**POOL-01 · Orchestrator** — prepare and register paths (the clean path is separate)

```
Trigger  Data tables · New row            RTR_PoolJobs                               concurrency 1
1   Data tables · Get record            RTR_Pool, workspace_key
2   Data tables · Get record            RTR_Secrets, workspace_key                                  🔒
3   Data tables · Update record         RTR_PoolJobs ‹trigger›: state = running, started_at = now
4   Data tables · Update record         RTR_Pool: last_job_id, last_correlation_id
5   Variables · Create                  proceed = false, package_id = ‹trigger›package_id
MONITOR
6   IF ‹trigger›command = prepare
    6.1   Update RTR_Pool               state = deploying
    6.2   IF ‹5›package_id is empty
          a  Call POOL-10              correlation_id, deployment_mode = ‹1›deployment_mode
          b  IF ‹a›ok false            → Call POOL-09 (POOL-10, ‹a›error) ; Stop job (error)
          c  Variables · Update        package_id = ‹a›package_id
    6.3   Call POOL-11a                workspace_key, correlation_id
    6.4   IF ‹6.3›ok false             → Call POOL-09 ; Stop job (error)
    6.5   Call POOL-11                 workspace_key, package_id = ‹5›package_id, correlation_id
    6.6   IF ‹6.5›ok false             → Call POOL-09 ; Stop job (error)
    6.7   Update RTR_Pool               state = configuring
    6.8   Call POOL-12                 workspace_key, reauthorize = false, correlation_id
    6.9   IF ‹6.8›ok false             → Call POOL-09 ; Stop job (error)
    6.10  IF ‹6.8›all_authorized false
          a  Update RTR_Pool           state = needs_connections, pending_connections = ‹6.8›pending.to_json
          b  Update RTR_PoolJobs       state = done, finished_at = now
          c  Stop job                  status = success
    6.11  Variables · Update            proceed = true
7   IF ‹trigger›command = register
    7.1   Dev API · List connections    target, folder_id = ‹1›folder_id
    7.2   IF ‹7.1›all_authorized false → Call POOL-09 (gate, NEEDS_CONNECTIONS,
                                         ‹7.1›pending.pluck(:name).to_json, pool_state = needs_connections)
                                         ; Stop job (error)
    7.3   Variables · Update            proceed = true
8   IF ‹5›proceed
    8.1   Update RTR_Pool               state = registering
    8.2   Call POOL-13                 workspace_key
    8.3   IF ‹8.2›ok false             → Call POOL-09 ; Stop job (error)
    8.4   Update RTR_Secrets            api_token = ‹8.2›api_token                                  🔒
    8.5   Update RTR_Pool               api_base_url, api_client_id, api_key_id, api_collection_id = ‹8.2›…
    8.6   Call POOL-14                 workspace_key, action = start
    8.7   IF ‹8.6›ok false             → Call POOL-09 ; Stop job (error)
    8.8   Dev API · Set API endpoints state   target, enable, api_collection_id = ‹8.2›api_collection_id
    8.9   IF ‹8.8›all_active false     → Call POOL-09 (endpoints, ENDPOINTS_INACTIVE,
                                         ‹8.8›results.where(active: false).pluck(:path).to_json) ; Stop job (error)
    8.10  HTTP · Send request           GET ‹8.2›api_base_url/health, header API-TOKEN = ‹8.2›api_token,
                                        don't raise on HTTP errors, no retries                       🔒
    8.11  IF ‹8.10›status ≠ 200        → Call POOL-09 (health, HEALTH_CHECK_FAILED, status + body) ; Stop job (error)
    8.12  Update RTR_Pool               state = available
    8.13  Update RTR_PoolJobs           state = done, finished_at = now
ON ERROR
E   Call POOL-09                        step = ‹error›step, code = UNHANDLED, message = ‹error›message
```

**POOL-09 · Fail job**

```
Trigger  Recipe function   in: job_id, workspace_key, step, code, message, pool_state (default failed)
1   Update RTR_PoolJobs     job_id: state = failed, step, error = code + ": " + message, finished_at = now
2   Update RTR_Pool         workspace_key: state = pool_state, last_error = {step, code, message}.to_json
3   Return result           ok = true
```

**POOL-10 · Build golden package**

```
Trigger  Recipe function   in: correlation_id, deployment_mode
1   Variables · Create      package_id, manifest_id
MONITOR
2   IF ‹trigger›deployment_mode = rlcm
    2.1   Dev API · Create or update export manifest
                            Target = registered, DEV; manifest_id = ‹prop›sdc_golden_manifest_id,
                            folder_id = ‹prop›GOLDEN_FOLDER_ID, auto_generate Yes, include_tags Yes, include_data No
    2.2   Dev API · Build and download package
                            mode rlcm; registered DEV; id = ‹2.1›id; download_content No
    2.3   Variables · Update  package_id = ‹2.2›package_id, manifest_id = ‹2.1›id
3   ELSE
    3.1   Dev API · Build and download package
                            mode projects; registered DEV; id = ‹prop›GOLDEN_FOLDER_ID;
                            description = correlation_id; download_content No
    3.2   Variables · Update  package_id = ‹3.1›package_id
4   Return result           ok = true, package_id, manifest_id, built_at = now
ON ERROR
E   Return result           ok = false, error = {BUILD_FAILED, ‹error›message}
```

**POOL-11a · Ensure custom connectors**

```
Trigger  Recipe function   in: workspace_key, correlation_id
1   Get record RTR_Pool
2   Get record RTR_Secrets                                                                          🔒
3   Dev API · List folder assets    registered DEV; folder_id = ‹prop›GOLDEN_FOLDER_ID; layout grouped
4   Variables · Create              connectors = [], all_current = true
MONITOR
5   Repeat  ‹3›by_type.custom_adapter
    5.1   Dev API · Ensure custom connector
                            source DEV; title = ‹item›name; target; note = correlation_id;
                            release Yes; skip_if_current Yes                                       🔒
    5.2   Variables · Update  connectors += {title, created, updated, released, current};
                            all_current = all_current AND ‹5.1›current
6   Return result           ok = ‹4›all_current, connectors, all_current,
                            error = {CONNECTOR_NOT_CURRENT, …} when false
ON ERROR
E   Return result           ok = false, error = {CONNECTOR_SYNC_FAILED, ‹error›message}
```

**POOL-11 · Import package**

```
Trigger  Recipe function   in: workspace_key, package_id, correlation_id
1   Get record RTR_Pool
2   Get record RTR_Secrets                                                                          🔒
3   Variables · Create      folder_id, project_id, deployed_count (int), deployed_detail
MONITOR
4   IF ‹1›deployment_mode = projects
    4.1   Dev API · Deploy package    mode projects; id = package_id; source DEV;
                                      Target = registered, target_environment = ‹1›target_environment;
                                      description = "prepare " + correlation_id
    4.2   Dev API · List projects     registered ‹1›target_environment; name = ‹prop›TARGET_PROJECT_PATH
    4.3   IF ‹4.2›found false         → Return result ok = false, error = {PROJECT_NOT_FOUND, ‹4.1›detailed_state}
    4.4   Variables · Update          folder_id = ‹4.2›match.folder_id, project_id = ‹4.2›match.id,
                                      deployed_count = ‹4.1›asset_count, deployed_detail = ‹4.1›detailed_state
5   ELSE
    5.1   Dev API · List projects     target; name = ‹prop›TARGET_PROJECT_PATH
    5.2   IF ‹5.1›found false
          a  Dev API · Create folder  target; folder_name = ‹prop›TARGET_PROJECT_PATH; parent blank
          b  Variables · Update       folder_id = ‹a›id, project_id = ‹a›project_id
    5.3   ELSE  Variables · Update    folder_id = ‹5.1›match.folder_id, project_id = ‹5.1›match.id
    5.4   Dev API · Deploy package    mode rlcm; id = package_id; source DEV; target;
                                      folder_id = ‹3›folder_id; folder_id_for_home_assets = ‹3›folder_id;
                                      restart_recipes No; include_tags Yes                        🔒
    5.5   IF ‹5.4›all_recipes_ok false → Return result ok = false,
                                      error = {IMPORT_PARTIAL, ‹5.4›recipe_status.where(ok: false).to_json}
    5.6   Variables · Update          deployed_count = ‹5.4›recipe_count, deployed_detail = ‹5.4›raw_status
6   Update RTR_Pool          folder_id, project_id, package_id, deployed_at = now
7   Return result            ok = true, folder_id, project_id, deployed_count, deployed_detail
ON ERROR
E   Return result            ok = false, error = {IMPORT_FAILED, ‹error›message}
```

**POOL-12 · Configure target**

```
Trigger  Recipe function   in: workspace_key, reauthorize (default false), correlation_id
1   Get record RTR_Pool
2   Get record RTR_Secrets                                                                          🔒
MONITOR
3   Dev API · Authorize Google connections   target; folder_id = ‹1›folder_id; reauthorize
4   IF ‹3›all_ok false     → Return result ok = false, error = {GOOGLE_AUTH_FAILED, ‹3›results.where(outcome: "failed").to_json}
5   Dev API · List connections              target; folder_id = ‹1›folder_id
6   Variables · Create      own_ids = ‹5›pending.where(name: in ‹prop›sdc_own_connection_names.split(",")).pluck(:id).to_json
7   IF ‹6›own_ids ≠ "[]"
    7.1   Dev API · Authorize connections   target; connection_ids = ‹6›own_ids; credential_source = input_json;
                                            input_json = {"api_token": ‹2›dev_api_token, …}; reauthorize   🔒
    7.2   IF ‹7.1›all_ok false → Return result ok = false, error = {CONNECTOR_AUTH_FAILED, ‹7.1›failed.to_json}
8   Dev API · Upsert properties             target; project_id = ‹1›project_id;
                                            [{workspace_key}, {router_base_url = ‹prop›…}, …]
9   Dev API · List connections              target; folder_id = ‹1›folder_id
10  Return result            ok = true, all_authorized = ‹9›all_authorized,
                             pending = ‹9›pending (id, name, application)
ON ERROR
E   Return result            ok = false, error = {CONFIGURE_FAILED, ‹error›message}
```

The connection-name list in step 6 is a property because provider keys are minted per workspace; names survive the import unchanged.

**POOL-API-03 · Register** — `POST /workspaces/register`

```
Trigger  API Platform · New API request     {workspace_key, correlation_id}
1   Get record RTR_Pool
2   IF ‹1› not found                        → Return response 404
3   IF ‹1›state not in [needs_connections, failed]  → Return response 409 {error: BAD_STATE, state}
4   Insert RTR_PoolJobs      {workspace_key, command = register, correlation_id, state = queued}
5   Update RTR_Pool           state = registering
6   Return response 202       {job_id = ‹4›id, correlation_id}
```

**POOL-13 · Register API client**

```
Trigger  Recipe function   in: workspace_key
1   Get record RTR_Pool
2   Get record RTR_Secrets                                                                          🔒
MONITOR
3   Dev API · List API collections      target; name = ‹prop›sdc_collection_name; project_id = ‹1›project_id
4   IF ‹3›found false       → Return result ok = false, error = {COLLECTION_NOT_FOUND, …}
5   Dev API · Find or create API client  target; name = ‹prop›sdc_api_client_name;
                                         api_collection_ids = ‹3›match.id; project_id = ‹1›project_id
6   IF ‹5›collections_match false → Return result ok = false, error = {CLIENT_MISMATCH, ‹5›id}
7   Dev API · Create or refresh API key  target; api_client_id = ‹5›id; name = ‹prop›sdc_api_key_name   🔒
8   Return result            ok = true, api_client_id = ‹5›id, api_key_id = ‹7›id, api_token = ‹7›auth_token,
                             api_base_url = ‹3›match.url, api_collection_id = ‹3›match.id              🔒
ON ERROR
E   Return result            ok = false, error = {REGISTER_FAILED, ‹error›message}
```

**POOL-14 · Set recipe state in order**

```
Trigger  Recipe function   in: workspace_key, action (start | stop)
1   Get record RTR_Pool
2   Get record RTR_Secrets                                                                          🔒
3   Data tables · Search records   RTR_RecipeOrder, all rows, sort position asc
4   Variables · Create       ordered_names = ‹3›rows.pluck(:recipe_name)  (reverse when action = stop),
                             ordered_ids = [], missing = []
5   Dev API · List recipes    target; folder_id = ‹1›folder_id
MONITOR
6   Repeat  ‹4›ordered_names
    6.1   Variables · Update   hit = ‹5›items.where(name: ‹item›).pluck(:id).first
    6.2   IF ‹hit› blank       → missing += ‹item›   ELSE ordered_ids += ‹hit›
7   IF ‹4›missing not empty  → Return result ok = false, error = {NAME_NOT_FOUND, missing.to_json}
8   Dev API · Set recipes state   target; action; recipe_ids = ‹4›ordered_ids.to_json; folder_id = ‹1›folder_id
9   Return result            ok = ‹8›all_ok, changed_count, failed = ‹8›failed, verified = ‹8›verified,
                             error = {STATE_FAILED, ‹8›failed.to_json} when not ok
ON ERROR
E   Return result            ok = false, error = {STATE_FAILED, ‹error›message}
```

Two things to notice reading these together. First, the only recipe that writes `state` is POOL-01, and there are exactly seven writes in it — the whole state machine is readable in that one recipe. Second, the pool row is read at the top of every function and its fields map straight onto the connector's target selector, so none of the functions below POOL-01 contain a single branch on target kind; the two mode branches that remain (POOL-10 step 2, POOL-11 step 4) exist only because projects-mode build and deploy are DEV-only endpoints.
