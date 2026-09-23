# lib_sdc 1.8.0 — schema 1.7 (repair release)

**Payload version unchanged (10.0).** No Workato handshake change. The serialized sheet grids return to the shape
the connector already parses.

## What was wrong

`PRIMARY_KEY_COLUMNS` (003_Schema.js) carried placeholder entries — the file said so — and
`PrimaryKey._ensureColumn` inserted a new column whenever the declared header cell did not match. Running
"PK column setup" from the menu therefore restructured three sheets:

| Sheet | Declared | Actual template | What happened |
|---|---|---|---|
| `6_variants` | PK `_pk_variants_` at B | no PK (cast of 4_fields) | column inserted at B; `All fields` → C, variant block → H |
| `4_complex_validations` | PK `_pk_rules` at B | `_pk_rules_` at B | second PK column inserted; both stayed empty |
| `5_lookups` | header row 8 | header row 5 | note text written into the PK cells of data rows 6–8; header cell B5 left blank |

Consequences: the connector's variant parse read UUIDs as field names (`CAN-01: Variant 'Variant_1' references
field '762734d6-…'`); `Variant._extractIncludedFields` produced an empty inclusion set, so every per-variant JSON
was silently emptied of fields; three lookup rows never received UUIDs; no rule row ever received one.

## What changed

- **003_Schema.js** — `PRIMARY_KEY_COLUMNS` reconciled to the template: four row-owning sheets only, `_pk_<name>_`
  headers, `5_lookups` data starts at row 6, explicit `keyColIndex`/`keyHeader` per entry. `6_variants` removed
  (`CAST_SHEETS` guard prevents re-adding it). Each `*_LAYOUT` gains `ANCHORS`. New `Layout.verify(ss)`.
- **006_PrimaryKey.js** — `_ensureColumn` never inserts a column: claims a blank header cell when the column below is
  empty/UUID-shaped, otherwise throws with the sheet, cell and reason. `_backfillSheet` keys rows off the declared key
  column instead of "PK + 1".
- **002_Migrations.js** — `1.6 → 1.7`: deletes the stray column on `6_variants` and `4_complex_validations`, writes the
  `5_lookups` header and clears the three note cells. Fingerprinted and idempotent; no-op on workbooks that never ran setup.
- **005_Preflight.js** — calls `Layout.verify`; a shifted or edited header fails every serializing flow by name, with
  the migration named when that is the fix.
- **008_Version.js** — LIBRARY 1.8.0, SCHEMA 1.7, schema history recorded.
- **011_Packs.js** — comment only (rules tab is now covered by backfill).

## Rollout

1. Push the library; bump consuming workbooks' library version.
2. Each workbook: **Migrate workbook schema** (onOpen offers it). Provision is blocked until this runs; validate/preview
   fail at preflight with the same instruction.
3. Next provision/validate stamps UUIDs into the freed rule and lookup rows.
4. Workato: nothing to change for `6_variants`. Re-check the `4_complex_validations` parser separately — it drops the
   first data row (0-based index 10); see the conversation notes.

`test_repair.js` replays all of this against the real `gas_export.json` under a mock Sheets API (23 checks).
