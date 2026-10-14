Flat, in order, with who or what performs each. Numbers run end to end; human steps are marked.

**Before any automation (ops, once per workspace)**

1. *(human)* In the client workspace, create a Developer API client scoped to the whole workspace, not a project list; note its token and data center.
2. *(human)* Insert the `RTR_Secrets` row: `workspace_key`, `dev_api_token`.
3. *(human)* Insert the `RTR_Pool` row: `workspace_key`, `data_center`, `target_kind` (`runtime` for a client, `registered` + `target_environment` for TEST/PROD), `deployment_mode` (`rlcm` / `projects`), `state = empty`.
4. *(standing)* Golden-side properties exist: `sdc_golden_manifest_id`, `GOLDEN_FOLDER_ID`, `TARGET_PROJECT_PATH` (equal to golden's project name), `sdc_collection_name`, router base URL.
5. *(standing)* `RTR_RecipeOrder` reflects golden's current call graph.

**Request**

6. *(workbook or human)* `POST /workspaces/prepare` with `workspace_key`, `correlation_id`.
7. Validate the payload.
8. Get `RTR_Secrets` by key → 409 if absent.
9. Get `RTR_Pool` → 409 unless `state` in `[empty, failed]`.
10. Insert `RTR_PoolJobs` `{command: prepare, state: queued, correlation_id}`.
11. `RTR_Pool.state → queued`.
12. Respond 202 `{job_id, correlation_id}`.

**Job pickup**

13. New-row trigger fires (concurrency 1).
14. Read the job row, the pool row, the secrets row.
15. `RTR_PoolJobs.state → running`, `started_at = now`.
16. `RTR_Pool.last_job_id`, `last_correlation_id` from the job.
17. Initialize variables: `package_id` (blank), `proceed = false`; derive the connector's target fields from the pool row and secrets.
18. Error monitor opens around everything below.
19. `RTR_Pool.state → deploying`.

**Build (always DEV, always registered)**

20. *(rlcm only)* Create or update export manifest: `manifest_id = sdc_golden_manifest_id`, `folder_id = GOLDEN_FOLDER_ID`, auto-generate Yes, include tags Yes, include data No.
21. Build and download package: mode per row, `id` = manifest ID (rlcm) or `GOLDEN_FOLDER_ID` (projects), download content No; long action polls to completion.
22. Capture `package_id` (the build ID in projects mode). Failure → fail job, stop.

**Sync custom connectors (both modes)**

23. List folder assets on DEV, `GOLDEN_FOLDER_ID`, grouped layout.
24. For each entry in `by_type.custom_adapter`: Ensure custom connector — source DEV, `title`, target per row, `note = correlation_id`, release Yes, skip if current Yes.
25. Confirm every result has `current = true`. Failure → fail job, stop.

**Import**

26. *(rlcm)* List projects on the target, `name = TARGET_PROJECT_PATH`; if not found, Create folder at root with that name. Capture `folder_id`, `project_id`.
27. Deploy package — rlcm: source DEV, runtime target, `folder_id`, `folder_id_for_home_assets = folder_id`, restart recipes No, include tags Yes; projects: source DEV, `target_environment`, `description = correlation_id`. Long action polls.
28. Check the outcome: `all_recipes_ok` (rlcm) or `detailed_state = deploy_finished` (projects). Failure → `IMPORT_FAILED` / `IMPORT_PARTIAL`, stop.
29. *(projects)* List projects on the target by name; capture `folder_id`, `project_id`.
30. Update `RTR_Pool` `{folder_id, project_id, package_id, deployed_at}`.

**Configure**

31. `RTR_Pool.state → configuring`.
32. Authorize Google connections on the target, `folder_id` (service account read from the connector's connection).
33. List connections on the target, `folder_id` → `pending`.
34. Select the pending shells that belong to your own connectors, matched by connection name.
35. Authorize connections: those connection IDs, credential source JSON built from `dev_api_token` — paced, roughly a minute per connection.
36. Upsert properties on the target, `project_id`: `workspace_key`, router base URL, any other per-workspace value.
37. List connections again → `all_authorized`, `pending`.

**Gate**

38. If `pending` is empty: continue to step 46.
39. Otherwise `RTR_Pool.state → needs_connections`, `pending_connections` = JSON of `pending`; `RTR_PoolJobs → done`; stop as success.
40. *(human)* Read `/status`, see the pending list.
41. *(human)* Authorize each pending connection in the client workspace UI.
42. *(human)* `POST /workspaces/register` with `workspace_key`, `correlation_id`.
43. Validate `state = needs_connections` (or `failed` from an earlier register) → 409 otherwise; insert job `{command: register}`; `RTR_Pool.state → registering`; respond 202.
44. Trigger fires; steps 14–18 repeat for the new job.
45. Re-run the gate: List connections on the target → if still pending, fail job `NEEDS_CONNECTIONS`, state unchanged, stop; else continue.

**Register**

46. `RTR_Pool.state → registering`.
47. List API collections on the target, `name = sdc_collection_name`, `project_id` → must be `found`; capture `id` and `url`.
48. Find or create API client on the target: fixed name, that collection ID, `project_id` → `api_client_id`; `collections_match = false` is a failure.
49. Create or refresh API key: `api_client_id`, fixed key name → `api_key_id`, `auth_token` (masked step).
50. `RTR_Secrets.api_token = auth_token` (masked step).
51. Update `RTR_Pool` `{api_base_url = collection url, api_collection_id, api_client_id, api_key_id}`.

**Start**

52. Read `RTR_RecipeOrder` ascending by `position`.
53. List recipes on the target, `folder_id`; map names to IDs; any unmatched name → `NAME_NOT_FOUND`, stop.
54. Set recipes state: start, the ordered IDs, `folder_id` → paced, verified; `all_ok = false` → `STATE_FAILED` with `failed[]`, stop.
55. Set API endpoints state: enable, `api_collection_id` → `all_active = false` → `ENDPOINTS_INACTIVE` with the inactive paths, stop.
56. HTTP GET `api_base_url/health` with the `API-TOKEN` header; anything but 200 → `HEALTH_CHECK_FAILED`, stop.

**Finish**

57. `RTR_Pool.state → available`.
58. `RTR_PoolJobs → done`, `finished_at = now`.
59. *(workbook)* Poll `/status`, copy `api_base_url` to the registry row, flip the engagement active. The token never leaves the router — `Route` reads it from `RTR_Secrets`.

**On any unhandled error at steps 19–58**

60. Error monitor → fail job with `code = UNHANDLED`, the step name and message → `RTR_PoolJobs → failed`, `RTR_Pool.state → failed`, `last_error = {step, code, message}`.
61. *(human)* Fix the cause, then re-run from step 6; every step from 20 onward is idempotent.
