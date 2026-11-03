# Opportunity-anchored write path — GAS changes

Companion to the Workato edit list. Eleven files; 149 hermetic tests pass (`runTests()`), 29 of them new.
Nothing here changes the review sheet's standing invariant: it stays a plain spreadsheet with no bound code.

## The idea in one paragraph

The recipe now anchors every contract on an Opportunity Id and derives account, owner-fallback, record type
and Name from it. On this side that means: the reviewer supplies the Opportunity (paste or pick), the gate turns
whatever they supplied into a bare Id and refuses to push without one, and the Config decides which other rows
are required and who owns new contracts. The extracted account name is still shown — it seeds the opportunity
suggestions — but it no longer goes to Salesforce. All of that is expressed through two small, general
mechanisms rather than field-specific code: **row roles** on `output_fields` lines, and **required labels**
from Config plus the schema.

## Mechanism 1 — row roles (`definitions/Config.js`, `Extract.js`, `Payload.js`, `ReviewSheet.js`, `Schema.js`)

An `output_fields` line may end in a marker. Parsed in `parseOutputFields_`, next to `=>`.

| Marker     | Prompted to the model | Shown on the sheet                    | Pushed to Salesforce | Reconciled against `_schema` |
| ---------- | --------------------- | ------------------------------------- | -------------------- | ---------------------------- |
| *(none)*   | yes                   | yes                                   | yes                  | yes                          |
| `[manual]` | **no**                | yes — Extracted blank and shaded      | yes                  | yes                          |
| `[info]`   | yes                   | yes — note "not sent to Salesforce"   | **no**               | no                           |

`field_roles` on the Config object carries them; `fieldRole_` / `labelsWithRole_` read them. `extractFields_`
prompts only non-manual labels and backfills manual ones as `''`; `buildPayload_` drops `[info]` labels from
`fields` (they stay in `provenance.extracted`); `refreshSchema` leaves `[info]` labels out of the
"Config labels not in Salesforce" warning.

## Mechanism 2 — required labels (`pipeline/Gate.js`, `pipeline/Schema.js`, `pipeline/ReviewSheet.js`)

`requiredLabels_(cfg, schema, labels)` is the one place that decides what must be filled: Config
`required_fields` (page-layout rules the API does not expose) ∪ schema entries with `required: true` (what the
API does expose — new `Required` column in `_schema`, written by the fetch-schema recipe change) ∪ the
Opportunity row. `validateApproval_` gains a third pass that reports every blank required cell at once; a typing
failure on the same cell is not reported twice. A `false` boolean is present, not blank — which is why the
recipe-side change to `x.to_s.present? ? x.is_true? : skip` matters: GAS now sends real `false`.

`planApprovedCells_` uses the same function to bold the Field cell, attach a "Required before this contract can be
sent" note, and highlight the Approved cell while it is blank, so the reviewer sees what blocks the push before
ticking Approved.

## The one named key — the Opportunity (`pipeline/Gate.js`)

Design note 9 in Gate.js owns this. `GATE_OPPORTUNITY_KEY = 'opportunity'` is the single wire key the gate knows
by name, because it is the value the recipe anchors on. `normalizeOpportunity_` finds a 15/18-char `006…` Id in
whatever is in the cell — bare Id, Lightning URL, Classic URL, or a dropdown suggestion — and the cell is required
by construction. Extending `/fetch-schema` with `referenceTo` would let this fall out of the schema later.

## Suggestions without a hidden map (`adapters/Workato.js`, `pipeline/ReviewSheet.js`)

`createReviewSheet_` calls `fetchOpportunityCandidates_` with the extracted text of the Config field named in
`opportunity_search_label` (e.g. Account Name). The call is best-effort: any failure logs a WARN and returns `[]`,
so a search outage can never stop a contract from being staged. Each dropdown option is `label [Id]`
(`candidateOption_`), so the chosen text already carries its Id and the gate reads it with the same regex it uses
for a pasted URL — no label→Id map has to live in the sheet. The dropdown allows invalid input, so pasting still
works.

## Owner (`definitions/Config.js`, `definitions/Payload.js`)

`contract_owner_email` is a Config key (validated as an email, lower-cased). `buildPayload_` puts it on the wire
as `fields.owner_email` when set and omits the key entirely when blank, so the recipe's `OwnerId` formula falls
back to the opportunity owner. A per-contract override later is one `[manual]` row with the same wire key.

## Config sheet rows to add / change (do this before `clasp push` takes effect on the next poll)

| Key                        | Value                                                                                                                                                       | Drawer |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `output_fields`            | remove the line whose wire key is `account_id`; add `Opportunity => Opportunity [manual]` and `Account Name [info]`; remove `Status` (recipe sets Draft) and `Contract Name` (recipe composes it) | editable |
| `required_fields`          | `Client Submission Date, Randstad Business, Type of Contract, Geographical Scope, Countries Supplying Services, Contract Start Date, Product Line(s)` (Salesforce labels resolve through the aliases) | editable |
| `opportunity_search_label` | `Account Name`                                                                                                                                              | editable |
| `contract_owner_email`     | the owner's email, or blank for the opportunity owner                                                                                                      | editable |
| `workato_search_url`       | the `/search-opportunities` endpoint URL without the query string                                                                                           | locked |

`parseConfig_` throws if a `required_fields` entry or `opportunity_search_label` does not resolve to an
`output_fields` line, so a typo shows up in the drawer, next to its field, instead of silently never blocking.

## Deploy

1. Add the Config rows above (the drawer can do all but `workato_search_url`).
2. `clasp push`; no new web-app version is needed (Dashboard.html is schema-driven and unchanged).
3. Run `runTests()` from the editor — expect 149 passed.
4. Run `refreshSchema()` once so `_schema` gains the `Required` column (old tabs read as not-required until then).
5. Review sheets already in Pending have no Opportunity row: add one by hand (label `Opportunity` in column A
   inside the grid, the Id in column C) or re-drop the original for re-extraction. New sheets get it automatically.
6. `runWorkatoTests()` after setting `opportunity` in `testPayload_` to the agreed test Opportunity Id; the
   `malformed opportunity (guard A)` scenario expects 400.

---

# 2026-11-03 — "Not found" phrases and gate errors on the cells

Seven files; 156 tests pass (7 new). Both changes keep the review sheet script-free.

## "Not mentioned in the document" never reaches Approved

The prompt asks the model to leave an absent field's section empty; it writes a phrase instead. `Config.js` gains
`blank_phrases` (defaults: "Not mentioned in the document", "Not mentioned", "Not specified", "Not stated",
"Not provided", "Not applicable", "N/A", "None"; override via the new drawer field under Extraction) and
`isAbsentPhrase_`, a whole-value, case-insensitive match that ignores whitespace and a trailing period.
Two consumers:

- `planApprovedCells_` keeps the phrase in **Extracted** (honest) and seeds **Approved** as blank — so a boolean
  seeds unticked, a date gets its picker on an empty cell, and a required row lights up as "needs attention".
  The cell's note says why.
- `validateApproval_` maps a phrase still sitting in Approved (older sheets, or a reviewer copying it across) to
  `''` before typing, so it is skipped when optional and reported when required, never sent as text.

`fieldInstruction_` now says "leave its section completely empty: do not write 'Not mentioned', 'N/A' or any
other placeholder", which reduces how often the phrase list is needed; the list is the guarantee.

## Gate failures: on the cells, and readable in Last error

`gateMessage_` replaces the separator-joined blob with a headline and one bullet per cell:

    Not sent — 3 cells need attention in the Approved column (each is also marked red on the sheet).
    Fix them and leave Approved ticked; the next poll retries.
    • Client submission date: "" is not a date; use YYYY-MM-DD
    • Late charge: "x" is not an option (…)
    • Opportunity: paste the Salesforce Opportunity Id or the record URL, or pick a suggestion

The Last error cell now wraps and keeps up to 2000 characters (`REVIEW_ERROR_MAX`, used by both `markError_`
and the repeat check in `processApprovals`, so Chat is still announced once per distinct failure).

`markCellErrors_` turns each failing Approved cell red and prepends the gate's line(s) to its note, above the
options note that was already there; `clearCellErrors_` undoes exactly that on the next attempt (red cells only,
⚠ paragraph only), so a fixed cell loses the red without losing its note, and creation-time yellow highlights are
untouched. `processApprovals` calls the first on a failed gate and the second just before a push.

## Deploy

`clasp push`, then `runTests()` (expect 156). No Config rows are required: `blank_phrases` defaults when absent.
Sheets already in Pending benefit immediately on their next poll (the gate-side mapping and the cell marks need no
re-creation); only the seed-as-blank behaviour applies to sheets created from now on.
