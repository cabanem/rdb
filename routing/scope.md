Four places, and the rule that ties them together: **golden is the template, the router is the only thing that knows about more than one workspace, each client workspace is a self-contained copy, and the Google side only ever talks to the router.**

```
config workbook ──(router token)──▶ ROUTER  /route ─────(api_token X)──────▶ CLIENT X  /provision, /invitations, …
routing workbook ─(router token)──▶ ROUTER  /workspaces/* ─(dev_api_token X)─▶ CLIENT X  Developer API
                                       │
                                       └────────(golden token)──────────────▶ GOLDEN    Developer API (manifest, export)
```

## By place

**Golden workspace** — the master copy; nothing serves a client from here.
- The SDC project folder: the ~58 estate recipes, the *client* API collection and its endpoints (`/provision`, `/invitations`, `/portal-invite`, `/health`), data table schemas, the WFA app and pages, the custom connectors the estate uses, connections (authorized with the SA, so golden can be exercised end to end), and any account/project properties the estate references.
- The export manifest (`sdc_golden_manifest_id`). Manifests are workspace-local; they describe golden's folder.
- A Developer API client whose token is the `GOLDEN` registered environment on the router's Dev API connector connection.

**Router workspace** — one; the only place with cross-workspace knowledge.
- Recipes: `RTR-API` + `Route`; `POOL-API-01/02/03`; `POOL-01`; `POOL-10…14`.
- The *router* API collection (`sdc-router-v1`) with `/route`, `/workspaces/prepare`, `/workspaces/{key}/status`, `/workspaces/register`, and its one API client/key — the **router token**.
- Data tables: `RTR_Secrets`, `RTR_Pool`, `RTR_PoolJobs`, `RTR_RecipeOrder`.
- The Dev API custom connector and its connection: `GOLDEN` as a registered environment, plus the SA email and private key.
- A Google Sheets connection to the registry (for `Route`'s `active` flip only).
- Account properties: `sdc_golden_manifest_id`, `sdc_golden_folder_id`, `sdc_collection_name`, router base URL.

**Client workspace X** — one per pool slot; a copy of golden plus what can't travel.
- Arrived in the package: the SDC project (`RTR_Pool.folder_id` / `project_id`), the 58 recipes, the client collection and endpoints (same paths, different base URL — `api_base_url` is per workspace because the collection URL carries the workspace prefix), table schemas, WFA app, custom connectors, connection *shells*, properties with golden's values.
- Created locally, never packaged: the Developer API client (ops, at `empty` → `dev_api_token`); the API Platform client + key on the client collection (POOL-13 → `api_token`); connection credentials (POOL-12: SA into Drive/Sheets, `dev_api_token` into your own connectors' shells, a human for anything OAuth-only); data table *rows*; per-workspace property values (POOL-12).

**Google side** — knows the router and nothing else.
- Routing workbook: `registry` (state, `api_base_url`, `activated_at`…), `_settings` (router base URL, router token, template ID, SA email, default editors), `_logs`.
- Config workbooks, one per engagement: `_developer_settings` holds the five webhook URLs (all router), the router token, `sharing.integrationAccountEmail` = the SA address, `meta.workspace_key`. No client workspace URI ever lands here.
- GCP: the one service account; its key lives only in the router's connector connection.

## What travels in the package, and what doesn't

| Travels from golden | Stays workspace-local |
|---|---|
| recipes, API collection + endpoint definitions, table schemas, WFA app/pages, custom connectors, connection shells, property *names* (with golden's values) | API clients and keys of both kinds, connection credentials, table rows, the manifest, `RTR_*` tables, the Dev API connector itself |

## Properties, specifically

Workato has two scopes — account (workspace-wide) and project — and both are packageable as `account_property` / `project_property` assets. Where a value lives is decided by one question: *is it the same in every client workspace?*

- Same everywhere (router base URL, collection name, feature flags): set once in golden, ship in the package, never touched again.
- Differs per workspace (`sdc.workspace_key`, anything that names the workspace): still defined in golden so the recipes resolve them, but golden's value should be a sentinel like `UNSET`, and POOL-12 overwrites it after every import. A sentinel means a missed overwrite fails loudly instead of running as golden.
- Router-only (`sdc_golden_manifest_id`, `sdc_collection_name`): router account properties; they are never in the manifest because golden's folder doesn't contain them.

Project ID and folder ID are different numbers for the same project; `upsert_properties` with `project_id` needs the former, which is why `RTR_Pool` carries both.

## The five credentials, by home

| Credential | Created where / by | Stored | Used by |
|---|---|---|---|
| Router token (API Platform key, router collection) | router, once, by hand | routing workbook `_settings`, each config workbook | workbooks → router |
| Golden Developer API token | golden, once, by hand | Dev API connection, `GOLDEN` env | POOL-10 |
| `dev_api_token` X (Developer API client in X) | X, by ops at `empty` | `RTR_Secrets` | POOL-11…14 via runtime override |
| `api_token` X (API Platform key on X's client collection) | X, by POOL-13 | `RTR_Secrets` | `Route` forwarding only |
| SA private key | GCP, once | Dev API connection | POOL-12 → X's Drive/Sheets connections |

The asymmetry to keep in mind: X's two tokens are *about* X but live in the router, and the router's own token lives on the Google side. Nothing on the Google side can reach a client workspace directly, and nothing in a client workspace knows the router exists except through the property values POOL-12 writes into it.
