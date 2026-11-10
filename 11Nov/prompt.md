# Task: add "Supplier manager email" to 1_customer and carry it through to the provision payload

## Context
Read first:
1. docs/architecture.md — §2 (Apps Script tier) and §5.1–5.2 (workbook → router → client collection)
2. docs/invariants.md — "Configuration and provisioning"
3. docs/generated/api-contracts.md — the `POST /provision` (API-00) request body; note the customer
   attributes it carries today (`client_name`, `analyst_email`, `expected_date`, `target_vms`,
   `reminder_days`, `customer_logo_url`)

Source in this repo:
- lib_sdc (library; identifier `SDC` in consumers): <path>
- bound_sdc-shim: <path>
- app_sdc-router (hosts the kickoff web app): <path>
- master_config template Sheet: <URL or ID> — I edit the template by hand from your instructions

Scope: the Apps Script side only. The Workato side (API-00 request schema, PRV-01, the Project
table, the Functional core connector) is a separate change; your last deliverable is the handoff for it.

## The change
Add one implementation attribute to `1_customer`:
- Label (column C): `Supplier manager email`
- Position: the row directly below `Customer logo public link` (confirm the exact current label
  from the template and the registry; use whatever the registry calls it)
- Type: email address. Validation: the same rule as the analyst email.
- Required: <yes | no>  (default: optional; an empty value is sent as empty, not omitted)
- Purpose: transported to Workato on provision. Nothing in the workbook consumes it.

"Full integration" means every place the existing seven attributes are known. Find those places by
tracing how `customer_logo_url` flows from its cell to the `/provision` body, then make the new field
flow the same way. I expect at least:
1. lib_sdc `CUSTOMER_FIELDS` registry entry: label, named range, wire name, type, validation,
   required flag, help text
2. a named range for the value cell — created by the migration step and present in the template
3. a schema bump and a new `MIGRATION_CHAIN` step that inserts the row (never overwrites a row),
   writes the label, creates the named range, and re-stamps the schema version on an existing
   workbook; it must be idempotent
4. the config export: the `_customer` block gains the field
5. the provision payload (`Provision.run` / `Config.build`): the field is sent on `/provision`;
   payload version bumped per the repo's convention (additive → I expect a minor bump)
6. pre-send validation: email format, plus the required rule if chosen, with Result-contract messages
7. the kickoff web app: the form renders the new field from the registry; the create-workbook path
   writes it; the Workspaces view and workbook health check, if they list customer attributes
8. the shim: expect no change unless a wrapper enumerates fields — confirm
9. START_HERE and sidebar help text: one line describing the field
10. tests: registry shape, migration (fresh template and already-migrated workbook), export shape,
    payload shape

Wire name: follow the convention the other attributes use. My expectation is `supplier_manager_email`.
Use the same name in `_customer` and in the `/provision` body.

## Constraints
- The constraints from docs/handoffs/2026-11-09-sidebar-validate-preview.md apply unchanged: shim
  thin, logic in lib_sdc, keep the Result / Stage.run / Log.forCorrelation patterns, the repo's own
  test and deployment methods.
- Read schema, library and payload versions from the code. Schema 1.11 / lib 1.12.0 may already be
  reserved for the 5_lookups primary-key removal; check whether that migration step exists. If it
  does, this change takes the next numbers. Never reuse a schema number.
- Do not touch the other seven attributes or their wire names (the `customer.*` rename is on hold).
- `config_fingerprint` covers `_customer`, so the first re-provision after migration will create a
  new version rather than answer `unchanged`. That is acceptable; state it in the handoff.
- Template edits are mine to make: give me exact cell-by-cell instructions and the named-range name,
  or make the migration step runnable against the template and tell me to run it there.

## Working method
1. Investigate and report: every file and function where the existing attributes are known (the
   `customer_logo_url` trace), current versions, your proposed wire name, version bumps and migration
   step, and anything in my list above that does not exist in the code. Stop and wait for approval.
2. Implement with tests. One commit.
3. Hand back: diff summary; version bumps and the shim manifest dependency change; template
   instructions; a manual test (new workbook from the template; an old workbook migrated; the
   field visible in the exported JSON and in the `/provision` body); and a Workato-side handoff that
   names the field, its type and requiredness, where it appears (`_customer` in the export JSON and
   the `/provision` body), the new payload_version, and what must change to accept it: API-00 request
   schema, PRV-01's Project write, the Project table column, and the Functional core connector if it
   validates `_customer` keys.
