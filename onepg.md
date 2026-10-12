# Workato Developer API connector — curl reference

Oct 12, 2026 · @Emily Cabaniss

## Setup

Every call the connector makes is a bearer-token request against one environment's data center. Set these once per shell; swap `DC` and `TOKEN` to point at a different workspace (that is all a runtime target does).

```bash
export DC=https://www.workato.com/api        # EU: app.eu.workato.com/api, SG: app.sg, JP: app.jp
export TOKEN=<api token from Settings > API clients>
alias wk='curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"'

wk $DC/users/me | jq .                       # the connection test, one per environment
```

Conventions on this page: `wk` carries the auth and JSON headers; `[...]` is optional; `×N` is one call per item; `$SRC`/`$TGT` stand for a second `DC`+`TOKEN` pair when a call crosses workspaces. Pipe through `jq` as you like. `(long)` marks actions the connector runs as long actions — on the command line you loop them yourself.

## Manifests and builds

RLCM builds from a manifest; Projects builds from a project folder (`f` prefix on the ID). Both report through a status endpoint whose `download_url` is pre-signed, so the final download carries no bearer token.

```bash
# List folder assets
wk "$DC/export_manifests/folder_assets?folder_id=$FOLDER[&include_data=true]"

# Create or update export manifest
wk -X POST $DC/export_manifests -d '{"export_manifest":{"name":"...","folder_id":'$FOLDER',
  "include_tags":false,"include_test_cases":false,"include_data":false,"auto_generate_assets":true}}'
wk -X PUT  $DC/export_manifests/$MANIFEST -d '{"export_manifest":{...same body; or "assets":[{"id":..,"type":..}]}}'

# Get / Delete export manifest
wk            $DC/export_manifests/$MANIFEST
wk -X DELETE  $DC/export_manifests/$MANIFEST

# Build package (async)
wk -X POST $DC/packages/export/$MANIFEST -d '{}'                     # RLCM
wk -X POST $DC/projects/f$FOLDER/build -d '{"description":"..."}'    # Projects

# Get build status   (RLCM: status=in_progress|completed ; Projects: state=pending|success)
wk $DC/packages/$PKG                                               # RLCM
wk $DC/project_builds/$BUILD                                       # Projects

# Build and download package (long) = POST build, poll status, then:
# Download package
URL=$(wk $DC/packages/$PKG | jq -r .download_url)
curl -sS -H 'Accept: */*' "$URL" -o package.zip                      # no Authorization header
```

## Deployments

Projects mode never authenticates to the target: deploy and every status poll go to the source (DEV), which names the target by `environment_type`. RLCM mode moves bytes: download from the source, POST the binary into a folder on the target, poll the target.

```bash
# Deploy package (long) / Deploy package (async) — Projects mode, all on $SRC
wk -X POST $SRC/project_builds/$BUILD/deploy \
   -d '{"environment_type":"test","description":"..."[,"include_tags":true]}'   # test | prod
wk $SRC/deployments/$DEPLOY                                 # Get deployment status; state + detailed_state + assets[]

# Deploy package (long) / (async) — RLCM mode
URL=$(curl -sS -H "Authorization: Bearer $SRC_TOKEN" $SRC/packages/$PKG | jq -r .download_url)
curl -sS -H 'Accept: */*' "$URL" -o package.zip
curl -sS -H "Authorization: Bearer $TGT_TOKEN" -H 'Content-Type: application/octet-stream' \
   --data-binary @package.zip \
   "$TGT/packages/import/$FOLDER?restart_recipes=false&include_tags=false[&folder_id_for_home_assets=$HOME]"
wk $TGT/packages/$IMPORT                                    # Get deployment status; status + recipe_status[]
```

Poll until `status` is `completed` (RLCM) or `state` is `success` (Projects); the connector waits 10 s × step, up to 10 steps. In RLCM, `completed` can still leave recipes stopped — read each `recipe_status[].import_result`; only `restarted` and `no_update_or_updated_without_restart` count as running.

## Folders, projects, recipes, properties

A project's `id` and its `folder_id` are different numbers: properties and API clients take the project ID; folders, imports and recipes take the folder ID. `Get environments`, `Get environment by name` and `Recipe to spec` make no HTTP calls.

```bash
# List folders / Lookup folder by path (one page per path segment, parent_id = previous match)
wk "$DC/folders?page=1&per_page=100[&parent_id=$PARENT]"

# Create folder (then read back) / Delete folder (read first; refuses is_project=true)
wk -X POST $DC/folders -d '{"name":"..."[,"parent_id":123]}' | jq .id   ;  wk $DC/folders/$FOLDER
wk $DC/folders/$FOLDER  ;  wk -X DELETE "$DC/folders/$FOLDER[?force=true]"

# List projects (filtering by folder_id or name is client-side)
wk "$DC/projects?per_page=100"

# List recipes / Get recipe / Inspect recipe
wk "$DC/recipes[?folder_id=$FOLDER]"                        # no per_page: API default page only
wk "$DC/recipes/$RECIPE[?includes[]=tags]"                  # .code is the step tree Recipe to spec walks

# Inspect recipes (batch): folder listing, then one GET per recipe
wk "$DC/recipes?folder_id=$FOLDER&per_page=100" | jq -r '.items[].id' | while read r; do wk $DC/recipes/$r; done

# Manage recipe / Set recipes state (long: 40 per minute, 60 s sleep on 429)
wk -X PUT    $DC/recipes/$RECIPE/start      # or /stop
wk -X DELETE $DC/recipes/$RECIPE
wk "$DC/recipes?folder_id=$FOLDER&per_page=100"             # the end-of-run verification listing

# Upsert properties / List properties (project_id = project ID, not folder ID)
wk -X POST "$DC/properties[?project_id=$PROJECT]" -d '{"properties":{"sdc_env":"test","sdc_region":"us"}}'
wk "$DC/properties?prefix=sdc_[&project_id=$PROJECT]"
```

## Connections

Connection writes share a quota of one request per second — space them out. The `input` object is provider-specific; the Google service-account shape below is what both Authorize actions send.

```bash
# List connections (authorization_status == "success" is the readiness gate)
wk "$DC/connections?[folder_id=$FOLDER][&project_id=$PROJECT][&external_id=$EXT][&includes[]=tags]"

# Update connection (any subset of these keys)
wk -X PUT $DC/connections/$CONN -d '{"name":"...","folder_id":123,"external_id":"...","shell_connection":true,"input":{...}}'

# Authorize Google connections / Authorize connections (long: one PUT per 2 s, then re-list)
wk "$DC/connections?folder_id=$FOLDER" | jq -r '.[] | select(.application=="google_drive" and .authorization_status!="success") | .id' |
while read c; do
  wk -X PUT $DC/connections/$c -d '{"input":{"authentication_type":"service_auth",
     "service_auth":"sa@project.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}}'
  sleep 2
done
wk "$DC/connections?folder_id=$FOLDER"                     # verify: authorized is what the API reports now

# Disconnect connection / Delete connection (delete is rejected while running recipes use it)
wk -X POST   $DC/connections/$CONN/disconnect -d '{"force":false}'
wk -X DELETE $DC/connections/$CONN
```

## API Platform

Collections and endpoints are v1 and return bare lists; clients and keys are v2 and wrap the payload in `{"data": ...}`. All share the 60-per-minute API Platform quota. A key's full `auth_token` appears only in the create and refresh responses.

```bash
# List API collections / List API endpoints (active needs the endpoint's recipe running)
wk "$DC/api_collections?per_page=100"
wk "$DC/api_endpoints?api_collection_id=$COLL&per_page=100"

# Set API endpoints state (then re-list to verify)
wk -X PUT $DC/api_endpoints/$EP/enable            # or /disable

# Find or create API client (list first; create only when the name is absent)
wk "$DC/v2/api_clients?per_page=100[&project_id=$PROJECT]"
wk -X POST $DC/v2/api_clients -d '{"name":"...","api_collection_ids":['$COLL'],"auth_type":"token"
   [,"project_id":'$PROJECT',"api_policy_id":1,"description":"..."]}'

# List API keys / Create or refresh API key / Refresh API key secret
wk "$DC/v2/api_clients/$CLIENT/api_keys?per_page=100"                          # tokens masked
wk -X POST $DC/v2/api_clients/$CLIENT/api_keys -d '{"name":"...","active":true[,"ip_allow_list":["10.0.0.0/8"]]}'
wk -X PUT  $DC/v2/api_clients/$CLIENT/api_keys/$KEY/refresh_secret           # .data.auth_token is the new token

# Delete API client / Delete API collection (disable endpoints first; 404 = already gone)
wk -X DELETE $DC/v2/api_clients/$CLIENT
wk -X DELETE $DC/api_collections/$COLL
```

## Custom connectors and teardown

Both sequences find before they write, so a rerun after a 429 is safe. `Ensure custom connector` matches on exact title (the provider key is minted per workspace); `Clean project` treats every 404 on a delete as done.

```bash
# Ensure custom connector — source, then target
CODE=$(curl -sS -H "Authorization: Bearer $SRC_TOKEN" "$SRC/custom_connectors/search?title=$TITLE" | jq -r '.[0].id' |
       xargs -I{} curl -sS -H "Authorization: Bearer $SRC_TOKEN" $SRC/custom_connectors/{}/code | jq -r .code)
wk "$TGT/custom_connectors/search?title=$TITLE"                               # absent → POST, present → PUT
wk -X POST $TGT/custom_connectors      -d "$(jq -n --arg t "$TITLE" --arg c "$CODE" '{title:$t,code:$c,note:"..."}')"
wk -X PUT  $TGT/custom_connectors/$CC  -d "$(jq -n --arg t "$TITLE" --arg c "$CODE" '{title:$t,code:$c,note:"..."}')"
wk -X POST $TGT/custom_connectors/$CC/release                                  # 400 "already released" is fine
wk "$TGT/custom_connectors/search?title=$TITLE"                               # read back: latest == latest_released

# Clean project — dry run is the first three calls
wk "$DC/projects?per_page=100"                                                # resolve by folder_id or name
wk "$DC/export_manifests/folder_assets?folder_id=$FOLDER"                     # inventory
wk "$DC/recipes?folder_id=$FOLDER&per_page=100" | jq '[.items[] | select(.running)] | length'   # must be 0
# real run, per API collection in the inventory:
wk "$DC/api_endpoints?api_collection_id=$COLL&per_page=100"  ;  wk -X PUT $DC/api_endpoints/$EP/disable  # ×active
wk -X DELETE $DC/api_collections/$COLL
wk -X DELETE $DC/projects/$PROJECT                                             # takes folders, recipes, connections, pages
wk -X DELETE $DC/data_tables/$TABLE                                            # ×tables; 404 expected
wk "$DC/projects?per_page=100"  ;  wk "$DC/connections?project_id=$PROJECT"    # verify: absent and empty

# Trigger: New completed build (Projects only)
wk "$DC/project_builds?since=2026-10-12T00:00:00Z"
```
