# SDC kickoff web app — proof of possibility

## Overview

A small Apps Script web app that creates an SDC configuration workbook from the BASE template and fills the 1_customer tab from a form, without the analyst opening a sheet. It is a demonstration that the web-app direction for Stage 1 (kickoff + 1_client) needs no new backend: the form is drawn from lib_sdc's existing `CUSTOMER_FIELDS` registry, values are written into the same named ranges the library reads, and the result is a workbook the rest of the platform cannot tell apart from a hand-filled one.

**What it demonstrates**

- The 1_customer shape already exists as data (`CUSTOMER_FIELDS`) and a form can be rendered from it with no second definition.
- One Drive copy of the BASE template yields a complete workbook: tabs, named ranges, `_developer_settings`, and the container-bound shim travel with it.
- Writing a value into a named range is equivalent to typing it; the readback through `SDC.Customer.read` is the evidence.
- Workbook creation and provisioning are separate actions; the app only performs the first.
- The implementation record sits behind one module (`Registry`), so moving it from RTR_Pool to a database later touches one file.

**What it does not demonstrate**

- Claiming a pool workspace. `REGISTRY_MODE=dry_run` records to a local tab; the `live` branch is written against the intent of lib_sdc 1.9.0's Registry module and has not been run.
- Applying a field pack. Packs are listed from the packs folder; applying one is left to the workbook's existing "Set up from field pack" menu.
- Provisioning. Not invoked. When wanted, it is `SDC.Provision.run(spreadsheetId)` called from the app instead of the shim.

## Getting started

1. Create a new Apps Script project (standalone, or bound to the routing workbook) and add the five files.
2. In `appsscript.json`, set the lib_sdc script ID and pin a version (1.9.0+). The app runs without the library, but then draws the form from a fixture and cannot read back.
3. Set script properties: `SDC_BASE_TEMPLATE_ID`, `SDC_WORKBOOKS_FOLDER_ID` (a shared-drive folder), optionally `SDC_PACKS_FOLDER_ID`, `DEMO_REGISTRY_SHEET_ID`, `REGISTRY_MODE` (`dry_run` default).
4. Deploy → New deployment → Web app: execute as *User accessing the web app*, access *Anyone within the organization*.
5. Open the URL. The context strip at the top says where the field definitions came from and which registry mode is active — if it says "fixture", the library is not attached.

## Authentication and connection

Google identity only, by design (analysts are the only users). Executing as the accessing user means the Drive copy and the sheet writes happen under the analyst's own account, so audit is free (`webapp.createdBy` in `_developer_settings`) and no shared credential is involved. The consequences: every analyst needs edit access to the workbooks folder and read access to the BASE template, and the folder must be on a shared drive so the integration account / service account can reach workbooks regardless of who created them. The app itself holds no router token; `_developer_settings` in the BASE copy carries `router.*` as it does today.

## Prerequisites

- BASE template on the master_config v0.9.9 layout with all `cfg_*` named ranges present (the app reports any it cannot find).
- lib_sdc 1.9.0 or later attached as `SDC` for live readback. Recommended: add `function getCustomerFields() { return CUSTOMER_FIELDS; }` to 003_Schema.js so the app does not depend on global exposure.
- For `REGISTRY_MODE=live`: the routing verification work (5 Oct handoff) complete, and the `SDC.Registry.claim` / `list` signatures confirmed against 013_Registry.js.

## Key actions

| Action | Where | What it does |
| --- | --- | --- |
| `getFormSchema` | 040_WebApp.js → 010_CustomerFields.js | Projects the registry into grouped form fields, plus a context block (user, source, registry mode, template configured). |
| `createImplementation` | 040_WebApp.js → 020_Workbook.js | Validates against the registry, copies BASE into the folder, writes each value to its named range, stamps `webapp.createdBy/createdAt`, reads back through `SDC.Customer.read`, records in the registry. |
| `getPacks` | 040_WebApp.js | Lists Google Sheets in the packs folder. |
| `listImplementations` | 030_Registry.js | Returns the implementation records (dry-run tab or live). |

Type handling is deliberately thin: `intList` is written as the normalized string `7, 14, 21` because the sheet cell holds a string and lib_sdc owns the parse; `date` is written as a Date; `int` as a number; `bool` through `BOOL_WRITE`.

## Error handling and telemetry

Validation failures (required fields, type shape) throw before any Drive copy is made, so a rejected form leaves nothing behind. Named ranges missing from the copy are reported in the result rather than thrown, because a partially written workbook is still useful evidence of which ranges the template lacks. Readback errors are surfaced verbatim. Nothing is logged beyond Apps Script's default execution log; a real deployment would add `Log.forCorrelation`-style entries through the library.

## Best practices

- Keep the field definition in lib_sdc. If a 1_customer field changes, it changes in `CUSTOMER_FIELDS`; the form follows on the next load. Resist adding fields to the app.
- Keep `Registry` the only module that knows where the implementation record lives.
- Leave provisioning as a separate button backed by the same library call the shim uses, so the shim path keeps working during the transition.
- Treat the readback as the acceptance test for Stage 1: a workbook created here must produce the same `Customer.read` values and the same content fingerprint as the same values typed by hand.

## Acknowledged risks and issues

- **Fixture fidelity.** The fixture in 010_CustomerFields.js is reconstructed from the schema-1.4 registry plus the 1.7.0 seed-row fields. One 1.4 entry could not be recovered; two rangeNames are inferred. Irrelevant once the library is attached.
- **`BOOL_WRITE` is unverified.** The representation of a `bool` cell in the live template (Yes/No, TRUE/FALSE, checkbox) must be checked before the seed-data flag is trusted.
- **Library signatures assumed.** `SDC.Customer.read(ss, config)`, `SDC.Config.build(ss)`, `SDC.Registry.claim/list` are called as understood from earlier work, guarded by try/feature checks, not verified against the current 1.9.0 source.
- **Global exposure.** Apps Script libraries publish top-level globals, so `SDC.CUSTOMER_FIELDS` should resolve; an explicit accessor removes the doubt.
- **Shared-drive ownership.** If the workbooks folder is on My Drive, workbooks are owned by whichever analyst clicked, and the integration principal may not see them.
- **The bound shim's library pin.** The copied shim inherits the BASE template's pinned lib_sdc version; the app may be on a newer one. Keep them aligned, or the two paths will disagree on schema.
- **Concurrency.** Two analysts creating implementations simultaneously is fine here (separate copies); it becomes a real question only when claiming is live, and RTR_Pool's claim recipe at concurrency 1 is the intended answer.
