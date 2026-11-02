# SDC kickoff web app — wired to lib_sdc 1.9.0

## Overview

An Apps Script web app that creates an SDC configuration workbook from the BASE template, fills 1_customer from a form, optionally applies a field pack, and records the implementation — without the analyst opening a sheet. Every step after the Drive copy is a lib_sdc call the container shim already makes from a menu, invoked here against a spreadsheet ID instead of the active sheet. Provisioning is a separate, gated action.

The form is drawn from `SDC.CUSTOMER_FIELDS` (17 fields, schema 1.8). The app defines no field of its own; it owns grouping and input kind only. The library judges the result: `Customer.read` for the readback, `Preflight.run({requireCustomerData: true})` for the "ready to provision" verdict, `Packs.apply` for packs, `Registry.claim` / `applyToWorkbook` for the binding.

**Demonstrated end to end (given the library is attached and BASE is configured)**
- Form rendered from the registry, grouped, with required-ness from the registry.
- Copy of BASE → migrate if the copy lags the library's schema → write through named ranges → read back → Preflight verdict, all logged to the new workbook's `_script_logs` under one correlation id.
- Pack listing, pack questions and pack application through `Packs.list` / `Packs.read` / `Packs.apply`, exactly as `setupFromPack` does.

**Written against the library but not exercised here**
- `REGISTRY_MODE=live`: `Registry.claim` + `Registry.applyToWorkbook`. The calls match 013_Registry.js; the router side is still under verification, so the default is a dry-run tab.
- `provisionImplementation`: `Provision.run(ss, {isInitial})`, off unless `ALLOW_PROVISION=true`.

## Getting started

1. New Apps Script project, bound to the routing workbook (so `_settings` is reachable) or standalone. Add the five files.
2. `appsscript.json` already names the lib_sdc script ID from the shim. Keep `developmentMode: true` only while iterating; pin a version for the deployment analysts use.
3. Script properties: `SDC_BASE_TEMPLATE_ID`, `SDC_WORKBOOKS_FOLDER_ID` (shared-drive folder). Optional: `REGISTRY_MODE` (`dry_run` | `live`), `HOST_SPREADSHEET_ID` (when standalone), `ALLOW_PROVISION`, and for live mode `ROUTER_LIFECYCLE_BASE_URL` / `ROUTER_API_TOKEN` / `ROUTER_BASE_URL` if not in `_settings`.
4. Deploy → Web app: execute as *User accessing the web app*, access *Anyone within the organization*.
5. The context strip shows the library and schema version the form was drawn from and the registry mode.

## Authentication and connection

Google identity only. Executing as the accessing user means the copy, the writes and the log lines are the analyst's own; `webapp.createdBy` in `_developer_settings` records who. Requirements that follow: every analyst needs read on BASE and edit on the workbooks folder; the folder must be on a shared drive so the integration principal reaches workbooks regardless of creator. Router calls (live mode) use the router API token from the routing workbook's `_settings`, the same token every claimed workbook uses — the app holds no secret of its own. Packs are read with the analyst's Drive access, as the shim does.

## Prerequisites

- BASE on the v0.9.9 layout with all `cfg_*` named ranges present; `_developer_settings` carrying `sharing.integrationAccountEmail` and `storage.packsFolderId` (Preflight and `Packs.list` need them). If BASE's `meta.schema_version` is behind 1.8 the app migrates the copy; better to migrate BASE itself once.
- lib_sdc 1.9.0+ attached as `SDC`.
- For live registry mode: the routing verification handoff (5 Oct) complete.

## Key actions

| Server function | Library calls | Notes |
| --- | --- | --- |
| `getFormSchema` | `CUSTOMER_FIELDS`, `Version` | Grouping and hints are the app's; everything else is the registry's. |
| `getPacks` / `getPackQuestions` | `Config.build(BASE)`, `Packs.list`, `Packs.read` | BASE's settings are the pre-workbook source of `packsFolderId`. |
| `createImplementation` | `Util.newCorrelationId`, `Log.append`, `Migrations.*`, `Config.build`, `Customer.read`, `Preflight.run`, `Packs.apply`, `Registry.*` | Order: required-field check → copy → migrate → write → stamp → read back → Preflight → pack → registry. Preflight failure is reported, not thrown: the workbook exists and can be finished in the sheet. |
| `provisionImplementation` | `Provision.run` | Gated by `ALLOW_PROVISION`. |
| `listImplementations` | `Registry.list` (live) | Dry-run reads the `demo_registry` tab. |

Type handling mirrors the library's readers: `intList` written as `7, 14, 21` (`Customer.parseIntList`), `date` as a Date in the workbook's time zone (`Util.toIsoDate`), `bool` as a native boolean (`Util.coerceTruthy`), `int` as a number. Blank form values leave the template's cell untouched.

## Error handling and telemetry

Required-field gaps throw before any copy is made. Each later step is recorded as a stage with ok/failed and detail; a stage failure after the copy still throws, and the partially built workbook remains for inspection. Preflight and pack outcomes are returned as verdicts with the library's own messages. Every run writes `INFO` / `SUCCESS` / `WARNING` lines to the new workbook's `_script_logs` under the run's correlation id, and `webapp.correlationId` is stamped in `_developer_settings`, so a workbook can be traced back to its creating run from inside the sheet.

## Best practices

- Fields live in `CUSTOMER_FIELDS`. A new 1_customer field is a schema bump in the library, not an edit here.
- `Registry` stays the only module that knows where the implementation record lives; the database swap later replaces that file.
- Provisioning stays a separate action backed by the same `Provision.run` the shim calls, so the menu path keeps working through the transition.
- Treat the Preflight verdict as Stage 1's acceptance test: a workbook created here must pass the same gate a hand-filled one does.
- Migrate BASE to the current schema rather than relying on the per-copy migration.

## Acknowledged risks and issues

- **lib_sdc `Config._secret` has a typo** (`gesScriptProperties`). It is swallowed by its try/catch and returns `''`, so the `SDC_ROUTER_API_TOKEN` script-property fallback for `router.apiToken` never works. Harmless today because workbooks carry the token in `_developer_settings`; worth fixing in 1.9.1.
- **`Packs.list` opens every Sheet in the packs folder** on each page load. Fine for a handful of packs; cache in `CacheService` once there are many.
- **`replace: true` on pack apply** matches the shim. If BASE ever ships default rows in 4_fields, the pack overwrites them; that is the shim's behaviour too.
- **Live registry is unexercised** until the router verification lands. `Registry.applyToWorkbook` requires a `routerBaseUrl`; the app takes it from `_settings → router.baseUrl` or falls back to `lifecycleBaseUrl`, per the one-collection decision of 5 Oct.
- **The bound shim's library pin** is whatever BASE pins. Running the app on 1.9.0 against a BASE pinned to 1.8.x means two code paths disagree on schema. Keep them aligned.
- **Shared-drive ownership.** On My Drive, workbooks belong to whichever analyst clicked.
- **`developmentMode: true`** in the manifest follows the shim's current convention; pin before analysts use it.
