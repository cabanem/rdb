# Description parser — spec dialects and contradiction lint

Three files change: `Extractor.js`, `DescriptionParser.js`, `Test.js`. `AiAdapter.js` is untouched.
`CHANGES.diff` shows every line that changed. `run-tests-node.js` runs the tests without Sheets.

## Why

Analysts paste the VMS field spec into the Description column. They do not write prose.
The old extractors were tested on prose, so they missed most of what the spec says.
They also never disagreed with a cell the analyst had already filled.

## What changed

### 1. A spec reader runs before the prose extractors (`Extractor.js`)

`dpPreparse_(description)` reads the spec's labelled parts into slots:

| Slot        | Read from                                                     |
|-------------|---------------------------------------------------------------|
| `head`      | First paragraph: `Required`, `Optional`, `Optional/Required`, `Required if …` |
| `qualifier` | The rest of that paragraph, or the next one if it starts with `(Required if …`, `If …`, `Only required when …` |
| `values`    | Lines after `Values allowed:`, `Allowed values:`, `Must be one of:`, `Options:`, `Valid values are:` … Bullets `●`, `•`, `-`, `*` or bare lines. `A = Add` legend lines are skipped. |
| `dataType`  | `Data Type: Character (4)` (also `Date Type:` — the VNDLY doc has that typo) |
| `length`    | The `(4)` in the type, or `Length: 50` |
| `example`   | `Example: 0214` — one line, ≤ 60 chars. A long "Example: if this contract…" stays prose. |
| `def`, `format` | `Default: …`, `Format: yyyy-mm-dd` |
| `prose`     | Everything else, with a sentence break at every paragraph break |

Two shapes are recognised:

- **labelled** — VNDLY. Markers like `Data Type:` and `Example:`.
- **positional** — Fieldglass tables. A type word, a length, and `Yes`/`No` on three lines (or one: `Text 16 Yes`). `Yes, if …` becomes a conditional.

A description with neither shape goes to the prose extractors unchanged. All 29 old tests still pass.

`dpSpecProposals_(spec, ctx)` turns the slots into proposals. The rule column on the review tab says `spec:labelled` or `spec:positional`, so you can see where a proposal came from.

| Spec says                          | Proposal                                                            |
|------------------------------------|---------------------------------------------------------------------|
| `Data Type: Character` / `String`  | Data type = string                                                  |
| `Decimal`, `Integer`, `Number`, `Boolean`, `Date` (or `Datex`) | float (2), integer, boolean, date                        |
| `Integer` but `Example: 1000.00`   | float (2), with a note                                              |
| `Character (4)` + `Example: 0214`  | Field length = `exact: 4`, regex `^\d{4}$`, Data type = string      |
| `Character (100)` + `Example: 123456` | Field length = `<= 100`                                          |
| `Decimal (max 99999.99)`           | Numeric field validation = `<= 99999.99`                            |
| `Example: 0214`                    | Data type = string. Note: as a number Excel would store 214.        |
| `Example: 2021-09-10`              | Data type = date, Data format = date (YYYY-MM-DD)                   |
| `Example: bob@example.com`         | Data format = email address                                         |
| A list of values                   | Data format = dropdown, Lookup name, new 5_lookups table            |
| `Required`                         | Required = TRUE (only when the cell is blank)                       |
| `Required if pay_type = 'daily'`   | 4_complex_validations: Required if, pay_type = daily                |
| `Required if "vendor_company_name" field is blank` | 4_complex_validations: At least one required            |
| `Time (hh:mm)`, `Decimal or "Auto"` | No type. A CHECK row says to choose by hand.                       |

When a spec names a type, the prose extractors' own type guesses are dropped. They were noise.

### 2. Contradiction lint (`Extractor.js` + `DescriptionParser.js`)

When the spec disagrees with a cell the analyst already filled, the scan writes a **lint row** instead of a proposal:

- Confidence column = `lint`. Never pre-ticked. "Accept all high-confidence rows" leaves it alone.
- Note starts with `CONTRADICTION:` (error) or `CHECK:` (warning), then says what happens if it is left as is.
- Proposed value = the fix, or `(no automatic fix — edit the cell by hand)`.
- Ticking a lint row and running Apply **overwrites** that cell. This is the one case Apply overwrites. Rows with no fix are skipped.

Lint rows produced today:

| Cell                     | Spec                                   | Row                                                   |
|--------------------------|----------------------------------------|-------------------------------------------------------|
| Required = TRUE          | `Optional`                             | CONTRADICTION, fix = FALSE                             |
| Required = TRUE          | `Optional/Required` + a readable rule  | CONTRADICTION, fix = FALSE, "a rule is proposed instead — accept both" |
| Required = TRUE          | `Optional/Required`, tenant-level condition | CONTRADICTION, fix = FALSE, quotes the condition, "decide for this project" |
| Required blank           | `Optional/Required`, no readable rule  | CHECK, no fix, quotes the condition                    |
| Data type = date         | `Character (4)`, `Example: 0214`       | CONTRADICTION, fix = string                            |
| Data type = string       | `Decimal` / `Date`                     | CONTRADICTION, fix = float (2) / date                  |
| Data type blank          | `Time (hh:mm)`, `Decimal or "Auto"`    | CHECK, no fix                                          |

To make this work, `dpRowContext_` now passes the row's current Required flag as `ctx.required`.

### 3. Symmetric rules are proposed once (`DescriptionParser.js`)

"At least one required" read from both `primary_vendor_user` and `vendor_company_name` is one rule.
The second copy is downgraded to medium with the note "same rule as the one proposed on … — accept only one".
Same for Mutually exclusive, Combined fields must be unique, Must match, Must not match.

### Small fixes

- ISO code patterns now match the spec wordings: `ISO-alpha 2 code`, `Alpha-3 country code`, `3-character ISO`.
- `dpMerge_` keys lint rows separately, so a lint row never displaces a real proposal.

## Numbers on the Sony workbook (master_config 1.0.0, 119 descriptions)

| Proposal                                  | Before | After |
|-------------------------------------------|-------:|------:|
| Dropdown + lookup table                   |      0 |    14 |
| Field length validation                   |      0 |    13 |
| Data type                                 |     33 |    72 |
| Regex (fixed-length digits, ISO codes)    |      0 |     6 |
| Complex rules usable as written (field + value) | 1 |     8 |
| Complex rules flagged for the reviewer (low) |   17 |    19 |
| Contradiction / check rows                |      0 |    33 |

Of the 33 lint rows, 26 are "Required is ticked but the spec makes it conditional".
9 of those come with a rule the sheet can enforce. The other 17 depend on a tenant setting
(pay groups, Workday integration, time entry). One yes/no per setting resolves each group.
The rest: 3 wrong data types (date/string vs the spec), 2 types with no equivalent, 2 conditional fields left blank.

## Install

Replace the four `.js` files in `sdc_lib`. The shim does not change: `dpScan`, `dpApply`, `dpAcceptHigh`, `dpClear`, `dpRunTests` keep their names and signatures.

Tests: `Description parser > Run extractor tests` in the sheet, or `node run-tests-node.js` here. 43 pass.

## Not done

- **Beeline.** I have no Beeline spec sample. Paste one field's description and I will add its markers. It is one table entry if labelled, one regex if positional.
- The AI adapter still receives the full description, not the prose slot. Fine while `DP_AI_MODE = off`.
- Asking the tenant-level questions (pay groups? Workday integration?) on the review tab and setting Required from the answers. That is the next step once the lint rows are in use.
- `.math_notation` and `.regex` tabs in the workbook: column names and tab name are out of date, and the first two regex patterns do not compile. That is a workbook fix, not a code fix.
