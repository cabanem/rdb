# Task: fix the Validate/Preview wiring in the SDC config-workbook sidebar, and add an "action in progress" window

## Context
You are working in the SDC (Supplier Data Collection) estate. Read these first, in this order:
1. docs/architecture.md — §1, §2 and §5.1 (the Apps Script tier and the workbook → router contract)
2. docs/invariants.md — "Routing", "Configuration and provisioning", "Platform constraints"
3. docs/generated/api-contracts.md — `POST /validate_configuration` (API-02), `POST /preview-template_file` (API-01), and the `/route` contract

Apps Script source in this repo:
- lib_sdc (library; identifier `SDC` in consumers): <path>
- bound_sdc-shim (container-bound script attached to each config workbook): <path>
- description-parser library (identifier `DP`), only if the sidebar touches it: <path>

docs/architecture.md §2 and §5.1 were written from my descriptions, not from code, and are tagged
[maintainer]. As you read the code, correct anything they get wrong and change the tag to [code].
Keep those corrections in their own commit.

## Problem 1 — Validate and Preview are crossed
In the shim's "Data collection guide" sidebar, clicking Validate appears to run Preview and/or clicking
Preview appears to run Validate. Before proposing any change, trace the full click path for BOTH buttons:
  sidebar HTML button → client-side JS handler → google.script.run.<global fn> → shim wrapper
  → SDC.<function> → router path (`/validate_configuration` or `/preview-template_file`)
  → what the response handler does with the result.
Present the trace as a table, one row per button, then state where the paths cross and why.
Check specifically: a shared dispatcher keyed by action name; step/stage names that differ between the
HTML and the library; handlers wired by position or index; a copied code block with an unchanged
function name; a cached or stale sidebar HTML file.

## Problem 2 — an "action in progress" window
When the analyst clicks any sidebar action (validate, preview, start, update, invitations), a window
must appear immediately, name the action, block a second click, and stay open until the action
resolves. On resolution it shows the outcome (the Result contract's status, message and details) and a
Close button. It must also resolve on failure (withFailureHandler) and on the Apps Script 6-minute
execution limit. It must never depend on a server-side call to close it.

Two implementations are possible; recommend one, with trade-offs, before building:
(a) a busy overlay inside the sidebar — simplest, no new HtmlService file;
(b) a modal dialog (SpreadsheetApp.getUi().showModalDialog) that itself invokes the action via
    google.script.run and closes with google.script.host.close() — truly blocking, a real window.
My lean is (b) if the action invocation can move into the dialog without duplicating logic; otherwise (a).

## Constraints
- The shim is thin and is copied into every workbook. Prefer changes in lib_sdc so one library version
  bump delivers them. Change the shim only where the bound project must expose a global function
  (client-side google.script.run can only reach globals of the bound project, not the library).
- Keep the existing Result contract, Stage.run and Log.forCorrelation patterns.
- Do not change the payload sent to the router, or any schema or payload version. This is a UI and
  wiring fix.
- Read the current lib_sdc version from the code; bump it per the repo's convention and tell me which
  shim manifest dependency version to change.
- Match the repo's existing test approach (Node tests exist for library logic). Add a test for any
  dispatcher or mapping logic you touch. UI changes get a short manual test script.
- Follow the repo's existing deployment method. Do not invent a new one.

## Working method
1. Investigate and report: the trace table, the root cause, your recommendation for Problem 2, and the
   list of files you will change. Stop and wait for my approval.
2. Implement in two commits: (1) docs corrections, (2) the fix, the progress window, and tests.
3. Hand back: diff summary, version bumps, manual test steps, and anything you could not verify.
