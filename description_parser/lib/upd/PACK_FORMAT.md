# Field packs

A field pack is a Google Sheet shaped like the config workbook. One pack per VMS × record type.
`Packs.apply` copies its rows into an implementation workbook. Analysts never edit a pack.

## Tabs

| Tab | Same as the workbook? | Notes |
|---|---|---|
| `4_fields` | Yes | Header row is found by the `_pk_fields_` anchor or the `Field name` header. Primary-key column left blank; the workbook stamps ids. |
| `4_complex_validations` | Yes | Anchor `_pk_rules_` or `Target field`. Default error message left blank; the workbook's `_mapping` supplies it. |
| `5_lookups` | Yes | Anchor `_pk_lookup_table_` or `Table name`. Code = Value = the item; Label blank; Record active TRUE; Project specific FALSE. |
| `_pack` | New | `key` / `value` rows. Read by `Packs.list` and `Packs.apply`. |
| `_questions` | New | One row per (question, field). Read by `Packs.plan`. |
| `_review` | New | Curator notes. Never read by code. Delete rows as you settle them. |

Columns are matched by header text, so column order and the spacer column in `5_lookups` don't matter.

## `_pack` keys

| key | meaning |
|---|---|
| `pack_id` | stable id, e.g. `vndly_contractor_work_order` |
| `vms` | `vndly`, `fieldglass`, `beeline` |
| `record_type` | the VMS upload this mirrors |
| `vms_spec_date` | date of the VMS spec the descriptions came from |
| `pack_version` | semver; `0.x` until reviewed |
| `schema_version` | config workbook schema the pack matches. `Packs.apply` refuses a major mismatch. |
| `reviewed_by` | who signed it off |

## `_questions`

| column | meaning |
|---|---|
| `question_id` | short id; the same id on several rows is one question governing several fields |
| `prompt` | what the analyst is asked, as a yes/no |
| `field` | a field name in `4_fields` |
| `effect` | what a **yes** does: `required` ticks Required; `include` keeps the field (a **no** drops it); `include+required` both |

Unanswered counts as no. A field with no question row is unaffected by questions.

## What `Packs.apply` does

1. Reads the pack. Refuses if the pack's `schema_version` major differs from the workbook's.
2. Refuses if `4_fields` already has rows, unless `replace: true`.
3. Applies the answers, then the scope (a list of field names, or all).
4. Drops rules whose target or condition field was dropped, and lookup tables no field references. Each drop is a warning on the Result.
5. Discovery mode sets `Strict?` FALSE on every field and rule.
6. Writes the three tabs under a document lock, stamps `_developer_settings` (`meta` / `pack_id`, `pack_version`, `collection_mode`, `pack_applied_at`), runs `PrimaryKey.backfill`, then `Validate.run`.

## Curating a pack

The `_review` tab in the candidate pack is the checklist. Work top to bottom:

1. Decide the `Strict?` default. The candidate has FALSE everywhere, copied from the source config.
2. Confirm or restore the removed rows. The candidate removed 43 rows whose name contained "Custom", started with "Job Charge Code:", or named the client. Five of them are tied to the Workday connector by the spec and may be standard for Workday-connected tenants.
3. Settle each "Conditional in the spec; Required left FALSE" row: a rule, a question, or leave optional.
4. Check the types the spec couldn't settle ("Type has no equivalent").
5. Fill `vms_spec_date` and `reviewed_by`, set `pack_version` to `1.0.0`, delete `_review` rows as you go.

## Reading a pack in tests

`test/packs.test.js` runs `Packs.plan` and the anchored table reader under Node against `test/fixtures/pack_vndly.json`,
which is this pack exported to JSON. Regenerate the fixture after changing the pack.
