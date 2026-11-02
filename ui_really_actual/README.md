# SDC implementations web app — files for app_sdc-router

## Overview

Five files that join app_sdc-router (the routing workbook's bound project) and give it a web front end over what its menu already does. **Workspaces** lists the registry with the lifecycle actions each state allows, shows a workspace's router status, and runs a health check on any workbook. **New implementation** generates a config workbook from the template, fills 1_customer from a form drawn from `SDC.CUSTOMER_FIELDS`, optionally applies a field pack, and claims a workspace for it the way "Claim workspace…" does — including the compensating release when the binding write fails.

Nothing is duplicated from Code.js: the app calls its `readSettings_`, `generateWorkbook_`, `refreshRegistry_` and `extractSpreadsheetId_` directly, so there is one definition of where the template is, what the router credentials are, and what the `registry` view looks like. The library supplies the rest.

**Demonstrated** in dry run: kickoff with readback and Preflight verdict, pack list/questions/apply, the health check, the list over workbooks created here. **Live mode** adds the router calls, which are the same `SDC.Registry.*` calls the menu makes, in the same sequence.

## Getting started

1. Add `010_CustomerFields.js`, `020_Workbook.js`, `030_Registry.js`, `040_WebApp.js`, `050_Health.js` and `Index.html` to app_sdc-router. Its `appsscript.json` already has the library and the webapp block; no manifest change.
2. `_settings` is the only configuration: `template.workbookId`, `template.destinationFolderId`, `router.*`, `workbook.*` as Code.js documents them. `readSettings_` requires the three `router.*` rows even in dry run.
3. Script properties: `REGISTRY_MODE` (`dry_run` default | `live`), `ALLOW_PROVISION` (`true` to enable the button).
4. Deploy → Web app. `#list` is the landing view, `#new` the kickoff form.

## Authentication and connection

As the routing workbook: the analyst's Google identity for Drive and Sheets, the router API token from `_settings → router.apiToken` for lifecycle calls. The app adds no credential and no script-property secrets. `template.destinationFolderId` should be a shared-drive folder so generated workbooks are not owned by whichever analyst clicked.

## Prerequisites

- Template workbook (`template.workbookId`) on the v0.9.9 layout at schema 1.8, with `storage.packsFolderId` in its `_developer_settings`. `sharing.integrationAccountEmail` may be blank there: the app writes `workbook.integrationAccountEmail` from `_settings` before Preflight.
- lib_sdc 1.9.0+ as `SDC` (already in the manifest).
- Live mode: POOL-API-01–07 applied and the 5 Oct verification complete.

## Key actions

| Server function | Calls | Notes |
| --- | --- | --- |
| `listWorkspaces` | `Registry.list` | Live: `GET /workspaces` rows (REGISTRY_COLUMNS) plus `_actions`. Dry run: the `demo_registry` tab. |
| `getWorkspaceStatus` | `Registry.status` | Shows state, API base URL, pending connections, last job, last error, then the raw row. |
| `workspaceAction(op, key)` | `Registry.prepare / register / release / close`, `refreshRegistry_` | Mirrors `lifecycleAction_`: confirm on the page, log under a correlation id, refresh the `registry` view. |
| `createImplementation` | `generateWorkbook_`, `Migrations`, `Customer.read`, `Preflight.run`, `Packs.apply`, `Registry.claim` + `applyToWorkbook` + migrate, `release` on failure | Mirrors `claimWorkspace` with one reordering: the workbook is generated and filled first, then claimed. A failed claim keeps the workbook and reports the error, as the menu does. |
| `checkImplementation(urlOrId)` | `Migrations`, `Config.build`, `Customer.read`, `Preflight.run`, `Log`, `FIELDS_LAYOUT` | Eight reported checks; works in both modes; accepts a URL or an ID. |
| `provisionImplementation` | `Provision.run` | Behind `ALLOW_PROVISION`; enabled only when the health check's Preflight passes. |

Buttons per state follow the menu items' own descriptions: `empty` / `failed` → Prepare; `needs_connections` → Register; `bound` → Release; `active` → Close; `inactive` → Release. Claim is the kickoff form.

## Error handling and telemetry

Router failures carry the library's message (HTTP status, `error_details`, and its hints about `_settings` on 401/404). Every write — create, claim, lifecycle action — logs to the routing workbook's `_script_logs` under a correlation id, and create also logs to the new workbook's own `_script_logs` under the same id, so a workbook and the routing workbook tell the same story. The health check never throws past opening the file; each check reports ok / attention with the library's own message.

## Best practices

- Keep `_settings` the one place configuration lives; do not reintroduce script-property copies of it.
- Keep `Registry` the only module that calls `SDC.Registry`; the database swap later happens there and in Code.js.
- Let the router be the state machine; the page only decides which buttons to show.
- Treat the health check as the pre-provision checklist.

## Acknowledged risks and issues

- **Code.js menu bug.** The "Dependency access" menu calls `grantLibraryAccessFromWorkbook`, but the function is named `grantLibraryAccessFromWorkbooks`; the item fails with "Script function not found" until one is renamed.
- **Code.js log status.** `grantLibraryAccess_` logs `'WARN'`; the Log schema's status set is INFO / SUCCESS / ERROR / WARNING. Best-effort, so it still writes, but it is the only non-canonical status in the estate.
- **lib_sdc `Config._secret` typo** (`gesScriptProperties`) — the script-property token fallback never works. Harmless here, since every token comes from a sheet.
- **Live mode is unexercised** until the router verification lands; the calls match Code.js line for line, which is the strongest claim available without running them.
- **Prepare and register return 202 jobs**; the page refreshes the list but does not poll `last_job`. Status on the row shows it.
- **`_validation_results` is read positionally** (A–C, row 2) per `VR_HEADERS`.
- **`Packs.list` opens every pack Sheet** on each form load; cache when the folder grows.
