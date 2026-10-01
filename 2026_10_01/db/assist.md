# SDC Master Config — Analyst User Guide

Oct 1, 2026 · @Emily Cabaniss

## How the workbook becomes a project

The workbook is the single source for everything a supplier sees and everything the platform checks. When you start a collection, the script packages tabs 1–7 as JSON and sends it to Workato, which parses the tabs into records, runs preflight, and freezes the result as a numbered version; that frozen version builds the template files, prefills them from seed data, and is the rulebook for every submission that comes back. Changing the workbook after that creates a new version; it never alters a template already sent.

&#91;embedded content: config lifecycle · 12 steps, 2 loops\]

Preflight failures loop back to the workbook before anything is built; validation failures loop back to the supplier with a report until the file is clean or the project's submission limit hands it to the analyst. Running Start again with no changes is a no-op — the fingerprint matches and the live version is reported back.

## Workbook map

The numbered tabs are the analyst's workspace; every other tab is either a reference or machinery the script reads and writes. Nothing you type outside tabs 1–7 reaches the platform, and nothing the platform needs is read from anywhere else.

| Tab | What it holds | What it changes downstream | Edit? |
| --- | --- | --- | --- |
| 1\_customer | 17 implementation attributes (client, dates, folder, reminders, seed-data settings, variant count) | Project record, template file names, reminder schedule, seed import settings | Yes — values only, never the labels |
| 2\_suppliers | Supplier roster, one row per supplier, with its template variation | One supplier record, one request and one template file per row | Yes |
| 3\_users | Portal users, each tied to a supplier | Portal logins and invitations; the first user listed per supplier owns the task | Yes |
| 4\_fields | The template blueprint: one row per column in the supplier file | Template columns, dropdowns, locks, in-cell checks; every server-side validation | Yes |
| 4\_complex\_validations | Rules that relate two fields in the same row | Cross-field checks on every submission | Yes |
| 5\_lookups | Dropdown values, grouped by table name | Dropdown lists in the template and on the form; membership checks | Yes |
| 6\_variants | Field × variant tick grid (left columns are cast from 4\_fields) | Which fields each variant's template contains | Tick boxes only |
| 7\_form | Field × visible tick grid | Which fields appear on the portal manual-entry form | Tick boxes only |
| .user\_guide, .math\_notation, .regex | Reference tabs | Nothing | No |
| \_description\_proposals | Review tab written by the description parser | Applies to 4\_fields only when you accept a row | Accept column only |
| \_error\_translation | Default message per error code | The wording of cross-field rule errors on the report | Only if asked |
| \_developer\_settings | Endpoints, Drive folder, template password, schema version | How the script talks to Workato | No |
| \_script\_logs, \_validation\_results | Written by the script on every run | Nothing — read them to see what happened | No |
| \_mapping, build, Sheet27, START\_HERE | Dropdown source lists and layout helpers | Nothing directly; the dropdowns on tabs 4–5 draw from them | No |

Three menu actions read these tabs: **Validate** (runs preflight and writes findings to \_validation\_results), **Preview template** (builds a sample file without provisioning) and **Start supplier data collection** (provisions the workspace). All three package the same tabs; only what happens afterwards differs.

## 1\_customer — implementation attributes

Each value is read by a named range behind its label, so the platform finds it even if rows are moved; it cannot find it if the label row is deleted or the value is typed into the wrong column. Rows marked \* are required and preflight fails when any is blank. Rows 11–15 become required only when the incumbent data flag is Yes.

| # | Label | Required | Enter | What it drives |
| --- | --- | --- | --- | --- |
| 1 | Analyst email address | Yes | One email | Analyst ownership and notifications; format is checked (warning only) |
| 2 | Application name | Yes | Short title | The collection's title as suppliers see it in the portal |
| 3 | Customer name | Yes | Client's name | File names (`<Customer>_<Variant>_<date>.xlsx`), the storage folder slug, and the CUSTOMER banner on every tab |
| 4 | Drive folder ID | Yes | The ID from the folder URL | Where templates and config exports are saved; must be shared with the integration account named in \_developer\_settings |
| 5 | Last day for data submission | Yes | YYYY-MM-DD | The deadline communicated to suppliers |
| 6 | Expected completion date | Yes | YYYY-MM-DD | The project's expected completion date on the record |
| 7 | Kick off email instructions | No | Free text | Body of the kick-off (pre-invite) email |
| 8 | Portal instructions | No | Free text | Instructions shown to suppliers in the portal |
| 9 | Reminder cadence | Yes | Day offsets, e.g. `3, 7, 14` | When reminders go out, counted from the initial request; separators can be comma, semicolon or space, and only positive whole numbers count |
| 10 | Incumbent data flag | Yes | Yes / No | Yes turns on the seed import and makes rows 11–15 required |
| 11 | Seed data Drive file ID | If seeding | The ID of the Sheet or XLSX holding incumbent data | The file the seed import reads |
| 12 | Seed data index key | If seeding | A field name from 4\_fields | The seed column whose values are supplier names; preflight fails if it is not a configured field |
| 13 | Seed data sheet name | If seeding | Worksheet name | Which tab of the seed file is read |
| 14 | Seed data header row | If seeding | 1-based row number; blank = 1 | Where the seed file's column headers sit (VMS bulk-load tabs often put them on row 5) |
| 15 | Seed data start row | If seeding | 1-based; blank = header + 1 | First data row; must be after the header row |
| 16 | Target VMS | Yes | e.g. VNDLY | Recorded on the project; field packs are keyed by VMS |
| 17 | Variant count | Yes | Whole number | Must equal the number of variant columns on 6\_variants; 0 means one base template with every field |

Dates are entered and stored as plain YYYY-MM-DD text; the platform converts them only where a timezone decision is made explicitly.

## 2\_suppliers — the roster

One row per supplier becomes one supplier record, one collection request and one template file. The supplier name is the key everything else joins on, so spell it once and reuse it.

| Column | Enter | Rules |
| --- | --- | --- |
| Primary key (UUID) | Nothing — the script fills it | Do not edit or clear |
| Supplier name | The business name | Must be unique (duplicate names fail preflight). 3\_users rows must match it exactly; seed-file names match it ignoring case and extra spaces |
| Template variation | Pick a variant name from 6\_variants | Must be a variant column that exists; a name that is not on 6\_variants fails preflight. Leave blank for the base template |
| Number of users | Nothing — a formula counts 3\_users | Derived, never read by the platform |

Blank rows are skipped. A supplier with no users still gets a request, but nobody can be invited to it until a user is added.

## 3\_users — portal users

Every user is scoped to one supplier; the portal authenticates by email and shows only that supplier's requests. The first user listed for a supplier is the primary contact and receives the data-collection task; later users for the same supplier can log in but do not own the task, and preflight notes them so you can reorder if the wrong person is first.

| Column | Enter | Rules |
| --- | --- | --- |
| Primary key (UUID) | Nothing — the script fills it | Do not edit |
| Supplier user email | Login and notification address | Format is checked (warning only); the same email twice under one supplier fails preflight |
| Supplier name | Pick from the dropdown of 2\_suppliers names | Must match a roster row exactly; an unknown name fails preflight |
| Supplier contact name | First and last name | Optional, used in correspondence |

A row with both email and supplier blank is ignored; a row with one of them blank is kept and will fail the supplier or email check.

## 4\_fields — the template blueprint

Each row is one column in the supplier's file, and every setting on the row does two separate jobs: it shapes the Excel template the supplier types into, and it defines the check the server runs when the file comes back. Excel can only block a few mistakes in-cell (a wrong type, a value off a dropdown); everything else is checked on submission and reported.

One rule governs the two columns that matter most: **Data type decides what kind of column the supplier gets** — text, date or number — and **Data format only picks how a value looks inside that kind**. The template and the server read the pair the same way.

| Column | Enter | In the supplier's file | At validation |
| --- | --- | --- | --- |
| Field name | The column header, exactly as the VMS expects it | Row 1 header; required fields get a red header and a trailing `  * ` | The key for seed matching, rules and the error report; must be unique |
| Data type | `string`, `integer`, `float (2)`, `date`, `boolean`, `none` | string: a text column that keeps exactly what is typed, leading zeros included; integer: whole numbers only; float (2): numbers only; date: a real date cell shown by its mask; boolean and none: text | integer: whole number; float (2): up to 2 decimals; date: YYYY-MM-DD; boolean: 0/1/true/false; string and none: anything |
| Data format | `dropdown`, `dropdown (dependent)`, `email address`, `currency`, `percentage`, `date (…)` | dropdown: Excel list; dependent: list filtered by the parent column; currency: a number shown as `#,##0.00` (an amount, never a code); percentage: a number shown as `0.00%` (a rate); `date (…)` on a date field: the display mask; `date (…)` on a string field: text, with a banner hint showing the form; email: a hint in the banner | dropdown: value must be in the lookup; email: must look like an address; currency: up to 2 decimals; percentage: numeric; `date (YYYY-MM-DD)` on a date field: the pattern; other date masks: not checked on the server |
| Description | One or two plain sentences for the supplier | Row 2, the grey locked banner under the header | Nothing (the description parser can derive settings from it, but validation never reads it) |
| Required | Tick | Red header, `  * ` suffix; in-cell checks stop allowing blank | A blank value fails the row — always blocking |
| Read-only | Tick | Column locked; the supplier cannot type in it. Only a seed can fill it | Nothing extra |
| Unique | Tick | Nothing | Repeated values within the file fail — always blocking |
| Lookup name | A table name from 5\_lookups | Source of the dropdown list | Value must be an active value of that table |
| Depends on | The parent's lookup name (dependent dropdowns only) | The list shows only children of what was picked in the parent column on the same row | Membership is checked against the parent's selection |
| Field length validation | Interval on character count, e.g. `exact: 4`, `[5, 20]`, `<= 30` | Nothing | Length outside the interval is reported; blocking only if Strict |
| Numeric field validation | Interval on the number, e.g. `>= 0`, `(0, 100]`, `<= 99999.99` | Nothing | Checked when the field is numeric: Data type integer or float (2), or Data format currency or percentage. Write a percentage range in the stored unit — a `0.00%` cell stores 12.5% as 0.125, so `[0, 1]`. Blocking only if Strict |
| Date field validation | Inequality on the date, e.g. `< TODAY`, `>= 2024-01-01` | Nothing | Checked only when Data type is date; blocking only if Strict |
| Field input validation | A regular expression | Nothing | Value must match; blocking only if Strict. Use it when the purpose-built columns cannot express the rule |
| Data cleaning flags | Comma-separated: `trim_whitespace`, `remove_control_chars`, `normalize_spaces`, `force_upper`, `force_lower`, `strip_non_numeric` | Nothing | Applied before any check; the cleaned value is what is validated and stored (the report still shows what was typed) |
| Strict? | Tick | Nothing | Ticked: length, range, date and regex failures reject the row. Unticked: they are reported as warnings and the row still lands |
| Hidden | Tick | Column present but hidden and locked | Nothing; preflight warns if Read-only is also ticked (redundant) |

Two checks are always blocking whatever Strict says: the integrity layer (Required, Data type, Data format, Lookup membership, Unique) and the cross-field uniqueness rule. Strict governs only the optional layer: length, numeric range, date range and regex.

Three choices follow from the type-decides-the-column rule:

- Codes that look like numbers — IDs, `0214` birthdays, `1`/`2` billing strategies — get Data type `string`. A string column is a text column in Excel, so `0315` stays `0315`; an integer column drops the zero before the file is even saved. Add `exact: 4` and `^\d{4}$` with Strict so wrong input is rejected rather than silently accepted.
- A currency *code* (`USD`) gets a blank Data format: `currency` means an amount and makes the column numeric on both sides, so the supplier could never type the code. Use a lookup of ISO codes or `^[A-Z]{3}$`.
- A partial date (`MM/DD`) gets Data type `string`: a `date` cell would store a year the supplier never typed and the server would receive it as YYYY-MM-DD. On a string field the `date (mm/dd)` label adds a banner hint and nothing more.

## 4\_complex\_validations — cross-field rules

A rule relates exactly two fields on the same row: the target (the field being judged) and the condition field (the one it is judged against). Rules run after the single-field checks, only on rows where the target field is in the supplier's variant, and only the rules that take a condition value compare it as exact text — `monthly` and `Monthly` are different values.

| Column | Enter |
| --- | --- |
| Target field | Pick the field the rule applies to |
| Rule or action | Pick a verb from the list below |
| Condition field | Pick the second field |
| Condition value | Only for `Required if` and `Must be empty if`: the exact value of the condition field that triggers the rule |
| Default error message | Filled from \_error\_translation; do not edit |
| Custom error message | Optional override; placeholders `{field_name}`, `{condition_field}`, `{provided_value}` are substituted |
| Strict? | Ticked: a failure rejects the row. Unticked: reported as a warning (except combined uniqueness, which always rejects) |

| Verb | Needs a condition value | Fails when |
| --- | --- | --- |
| Required if | Yes | Condition field equals the value and the target is blank |
| Must be empty if | Yes | Condition field equals the value and the target has a value |
| At least one required | No | Both fields are blank |
| Mutually exclusive | No | Both fields have a value |
| Must match | No | The two values differ |
| Must not match | No | The two values are identical (and not blank) |
| Must be greater than / greater than or equal to | No | Target ≤ (or <) the condition field |
| Must be less than / less than or equal to | No | Target ≥ (or >) the condition field |
| Combined fields must be unique | No | The pair (target, condition field) repeats within the file |

The four ordering verbs compare numbers when both fields are numeric (integer, float (2), currency, percentage) and dates when both fields are `date`, so `end_date` greater than `start_date` works as you would expect. Any other pairing — a date against a number, or either against plain text — is a configuration error; the rule cannot be evaluated. A value that already failed its own type check is not compared, so a malformed date gets one error on the report, not two.

`At least one required` and `Mutually exclusive` are symmetric: one row covers the pair, so do not add a second row with the fields swapped. A rule whose target or condition field is not on 4\_fields fails preflight.

## 5\_lookups — dropdown values

A lookup is a named list of allowed values; a field binds to it by putting the table name in Lookup name. The same list feeds the Excel dropdown, the portal form and the server's membership check, so a value missing here is a value no supplier can submit.

| Column | Enter | Effect |
| --- | --- | --- |
| Table name | The lookup's name, same on every row of the list | Groups rows into one list; what 4\_fields references |
| Code | Optional short code | Not read by the platform today |
| Value | The option exactly as the supplier submits it | What appears in the dropdown and what is matched on validation; must be unique within the table (and within its parent, for dependent lists) |
| Label | Optional display text | Parsed but not shown in the Excel template today |
| Parent value | Blank for a plain list; for a dependent list, a Value from the parent lookup | Decides which parent selection reveals this option |
| Record active? | TRUE / FALSE | FALSE rows are ignored entirely — not in the dropdown, not accepted on validation |
| Project specific? | TRUE / FALSE | Marks client-specific values; no effect on validation |

**Dependent (cascading) dropdowns.** Build the parent as a plain list (`country`: US, CA). Build the child as a second table where every row carries a Parent value (`state`: Ohio under US, Ontario under CA). On 4\_fields, give the child field Data format `dropdown (dependent)`, Lookup name `state` and Depends on `country`; a field bound to `country` must exist in the same variant, or the template build fails. In the supplier's file the child column lists only the children of what was picked in the parent column on that row.

Three preflight rules keep a cascade honest: every child row needs a Parent value (a bare row would make the list render flat); every Parent value should have at least one child (a parent with none gives the supplier an empty list — warning); and a value that must appear under two parents needs a distinguishing suffix, `Commercial~FR` and `Commercial~DE`, because the value itself must be unique to one parent. The supplier sees the suffixed value.

A plain `dropdown` bound to a table whose rows all carry parents renders empty, and preflight warns.

## 6\_variants — template variations

A variant is a subset of the fields; the platform builds one template file per variant and each supplier receives the one named on 2\_suppliers. The left columns (All fields, Data type, Data format, Lookup name, Depends on) are cast from 4\_fields and must not be edited; the variant columns to their right are headed by the variant names, generated from the Variant count on 1\_customer.

| Situation | What happens |
| --- | --- |
| Variant count 0, no variant columns | One template named `base` with every field is synthesized; this is the normal single-template case |
| A tick in a variant column | That field is a column in that variant's file |
| A variant with no ticks | Preflight fails: every variant needs at least one field |
| Variant count differs from the columns found | Preflight warns and names the mismatch; check the header row of 6\_variants |
| A supplier's Template variation names a variant that does not exist | Preflight fails |
| A dependent dropdown ticked without its parent field | The template build fails for that variant |
| A cross-field rule whose target is not in the variant | The rule simply does not run for that variant |

The platform finds the variant block by the `All fields` and `Depends on` headers, not by column letter, so inserting a column inside the cast block breaks the layout and inserting one after it creates an unnamed variant. Add variants by raising the count on 1\_customer.

## 7\_form and \_error\_translation

**7\_form** controls the second submission channel: the portal's manual-entry form. A tick in `Visible?` puts the field on the form; the Excel template is unaffected and always carries every field of the variant. The form has a fixed number of slots per data family, shown in the `max_count` column (as of this workbook: 26 string, 10 dropdown, 10 dependent dropdown, 4 date, 4 integer, 4 float, 2 boolean); the `actual_count` column counts your ticks against it. Exceeding a family's slots does not stop provisioning — the form channel is marked unavailable for the project and suppliers must use the file upload. Both channels run the same validation.

**\_error\_translation** holds the default wording for each error code, with placeholders `{field_name}`, `{provided_value}`, `{expected_value}`, `{condition_field}` and `{expected_interval}` substituted at report time. It feeds the Default error message column on 4\_complex\_validations and the wording of cross-field errors on the supplier's report; single-field messages (required, type, format, length, range, lookup, unique) are fixed by the platform. To change how one rule reads, use the Custom error message on its row rather than editing this tab.

## Preflight — the checks that run before anything is built

Validate and Start both run 27 checks against the parsed workbook and write every finding to \_validation\_results. One failed check makes the configuration invalid and nothing is provisioned; warnings are recorded and provisioning continues. Fix failures in the tab named in the finding, then run Validate again.

| Check | Severity | Fails or warns when | Fix |
| --- | --- | --- | --- |
| customer\_required\_attributes | fail | A starred 1\_customer value is blank | Fill it |
| seed\_data\_config | fail | Incumbent flag is Yes but file ID or index key is blank, the index key is not a field name, or the start row is not after the header row | Correct rows 11–15 |
| required\_fields\_present | fail | No fields or no suppliers | Add rows |
| no\_duplicate\_field\_names | fail | Two 4\_fields rows share a name | Rename one |
| no\_duplicate\_supplier\_names | fail | Two roster rows share a name | Merge or rename |
| no\_duplicate\_user\_per\_supplier | fail | Same email twice under one supplier | Remove one |
| user\_supplier\_exists | fail | A user names a supplier not on 2\_suppliers | Fix the spelling |
| supplier\_variant\_exists | fail | A supplier's Template variation is not a 6\_variants column | Pick an existing variant |
| variant\_field\_exists | fail | A variant ticks a field that no longer exists | Re-cast 6\_variants |
| variant\_has\_visible\_fields | fail | A variant column has no ticks | Tick at least one field or lower the count |
| variant\_count\_matches | warn | Variant count on 1\_customer differs from the columns found | Align the two |
| lookup\_references | fail | A field's Lookup name is not a table on 5\_lookups | Add the table or fix the name |
| lookup\_has\_values | fail | A bound table has rows but every Value is blank | Fill values |
| depends\_on\_references | fail | A Depends on names a table that does not exist | Fix the name |
| lookup\_name\_no\_self\_reference | fail | A field depends on its own lookup | Point Depends on at the parent table |
| dependent\_dropdown\_has\_parent | fail | A dependent dropdown lacks a Lookup name, a Depends on, or no field uses the parent table | Complete the cascade |
| ambiguous\_cascade\_parent | fail | The parent table is bound by two fields, so the platform cannot tell which gates the child | Bind the parent table to one field |
| cascade\_parent\_values\_populated | fail | Child rows lack a Parent value, or a Parent value is not in the parent table | Fill or correct Parent value |
| cascade\_suffix\_disambiguates | fail | A suffixed value sits under more than one parent | Give each its own suffix |
| cascade\_parent\_has\_children | warn | A parent value has no child rows | Add children or accept the empty list |
| no\_duplicate\_lookup\_entries | fail | Same Value (and parent) twice in a table | Remove the duplicate |
| dropdown\_has\_lookup | warn | Data format is dropdown but Lookup name is blank; the column renders as free text | Bind a table |
| plain\_dropdown\_lookup\_has\_root\_values | warn | A plain dropdown's table has only parented rows; the list renders empty | Make it dependent or add unparented rows |
| rule\_target\_field\_exists | fail | A rule's Target field is not on 4\_fields | Fix the name |
| rule\_condition\_field\_exists | fail | A rule's Condition field is not on 4\_fields | Fix the name |
| interval\_notation\_valid | fail | A length, numeric or date validation cannot be parsed | Use the notation in the quick reference |
| email\_format\_valid | warn | The analyst email or a user email does not look like an address | Correct it |
| hidden\_field\_readonly\_redundant | warn | A hidden field is also read-only | Untick Read-only |

The parser also records warnings of its own before these checks run: a 4\_fields column it does not recognise (its values are discarded), a mapped column it cannot find (read as blank), an unknown data type or rule verb, and non-blank rows sitting between a header and its first data row. Read the top of \_validation\_results after a run that gave fewer fields or rules than you expected.

## What the supplier receives

Each variant becomes one protected Excel file named `<Customer>_<Variant>_<YYYYMMDD>.xlsx` (`base` when there are no variants), built from the frozen configuration so it cannot drift from what the server will later check. The supplier sees one data tab; a second tab holding the dropdown lists is very-hidden and cannot be unhidden from Excel.

| Part of the file | Comes from | Notes |
| --- | --- | --- |
| Row 1, headers | Field name, in 4\_fields order | Required fields: red header, `  * ` suffix. Others: blue. Panes freeze below row 2 |
| Row 2, grey banner | Description, plus a hint for email fields and for a date mask on a text field (`Enter as text in the form MM/DD.`) | Locked; the only guidance the supplier reads in-cell |
| Rows 3 to 10,002 | Empty, or prefilled from the seed | 10,000 data rows; a seed slice larger than that fails |
| Column width | Header length | Hidden fields: column hidden |
| Cell lock | Read-only or Hidden | Locked columns cannot be typed into; everything else is open |
| Dropdown | Lookup name | Plain list, or a list filtered by the parent column on the same row |
| Column kind | Data type (and currency / percentage format) | string, boolean, none: Excel Text, kept exactly as typed; date: a date cell; integer, float (2), currency, percentage: a number cell |
| In-cell type check | Data type / Data format | Whole number for integer; number for float, currency and percentage; a real date for date fields. Blank allowed unless Required. Text columns have no in-cell check |
| Display format | Data format | `yyyy-mm-dd` or the chosen mask for dates, `#,##0.00` for currency, `0.00%` for percentage |
| Protection | Password from \_developer\_settings | Sheet and workbook structure are locked; the supplier cannot add tabs or lift the locks |

**What Excel cannot enforce.** Length, numeric range, date range, regex, uniqueness, required-if and every other cross-field rule are not checked in the cell; they are checked when the file is submitted and come back on the validation report. The banner text is the place to warn the supplier about them.

Seed-prefilled cells keep the column's lock state and display format: dates and numbers are written as real dates and numbers where the column calls for them, and anything prefilled into a text column is written as text so a leading zero survives. A seed value that does not parse as its column's type is written as typed so the supplier can see and fix it.

## Incumbent (seed) data

A seed is one multi-supplier file whose columns are the configured field names and whose rows belong to roster suppliers; the platform splits it by supplier and prefills each supplier's template. It is read from the Drive file, sheet, header row and start row set on 1\_customer.

| Expectation | Detail |
| --- | --- |
| Header row | Field names from 4\_fields. Matching ignores case, extra spaces, a trailing `  * `, and treats `_` and space alike (`Worker First Name` matches `worker_first_name`) |
| Index column | The Seed data index key; its cell holds the supplier name. Rows with a blank index are skipped |
| Supplier names | Matched to 2\_suppliers ignoring case and extra spaces. Several spellings of one supplier merge into one slice |
| Unknown columns | Ignored with a warning; a column that maps to the same field twice is ignored |
| Read-only fields | Should have a seed column — a locked cell can only be filled by the seed; missing ones are warned |
| Values | Validated like a submission, with cleaning flags applied. Blank required fields are warnings (the supplier fills them), unless the field is read-only |
| Size | At most 10,000 rows per supplier |

A supplier name in the seed that cannot be seeded is reported with the reason: not on the roster (add the supplier), on the roster with no request yet (activate it), request in validation or review (seed later), or request approved or cancelled (re-opening is an analyst action). A name that matches two roster rows, or a supplier with two open requests, fails the seed report until the roster is fixed.

## Common mistakes and how they surface

The two failure modes are opposite and equally costly: a config that specifies nothing collects whatever Excel produces, and a config that specifies everything rejects data that was fine. The target is the middle — type and format on every field, Required where the VMS requires it, and the optional layer only where the VMS will reject the value.

| What you see | Cause | Fix |
| --- | --- | --- |
| IDs and birthdays come back without leading zeros | Data type `integer` | `string` (a text column) + `exact: N` + `^\d{N}$`, Strict ticked |
| Suppliers cannot enter `USD` in a currency-code column | Data format `currency` on a code field; currency means an amount and the column becomes numeric in Excel and on the server | Clear Data format; keep `^[A-Z]{3}$` or bind a lookup of codes |
| A month/day field comes back with a year, or as a real date | Data type `date` with format `date (mm/dd)` | Data type `string`; the label then only adds the banner hint |
| A numeric range you set is never enforced | Data type `string` with no numeric format; ranges run for integer, float (2), currency and percentage | Set Data type to `float (2)` or `integer`, or Data format to `currency` |
| A date rule you set is never enforced | Data type is not `date` | Set Data type to `date` with format `date (YYYY-MM-DD)` |
| An end-after-start rule never fires, or always fails | One of the two fields is not `date`-typed (or, for amounts, not numeric) | Give both fields the same kind |
| Length, range or regex failures appear as warnings and the rows still load | Strict unticked | Tick Strict on that field |
| `Required if` never fires | Condition value differs in case or spacing from the lookup value | Copy the value from 5\_lookups |
| `Required if` never fires on a numeric condition value | The cell was typed as a number and arrives as `1.0`, which never equals `1` | Enter it as text (prefix it with an apostrophe in Sheets) |
| A dropdown column is free text in the file | Data format `dropdown` with no Lookup name, or the table has no active rows | Bind the table; set Record active? TRUE |
| A dependent dropdown is empty | Child rows lack Parent value, or the parent field is not in the variant | Fill Parent value; tick the parent on 6\_variants |
| Template build fails with PARENT\_FIELD\_NOT\_IN\_VARIANT | Child ticked in a variant without its parent | Tick both |
| Fewer fields or rules parsed than you entered | A renamed column header, or a row typed above the header | Restore headers; read the parser warnings in \_validation\_results |
| Supplier gets no task | Their user is not first under the supplier, or no user exists | Reorder 3\_users |
| Seed rows skipped for a supplier | Name spelt differently than on 2\_suppliers, or the request is not in pending/sent | Align the name; check the request status |
| Same rule listed twice | `At least one required` entered from both fields | Keep one row |
| Regex duplicating a dropdown | Both a lookup and a pattern on one field | Keep the lookup; the pattern adds nothing and breaks when the list changes |

The Description column is for the supplier. Pasting the VMS field spec into it works for the description parser, but the supplier reads it in a 56-pixel banner; once the parser has proposed its rules, shorten the text to what the supplier needs.

## Quick reference

| Interval notation | Meaning | Used in |
| --- | --- | --- |
| `exact: 9` | Exactly 9 | Length, numeric |
| `[5, 10]` | 5 to 10 inclusive | Length, numeric |
| `(5, 10)` | Strictly between 5 and 10 | Length, numeric |
| `[0, 100)` / `(0, 100]` | One end inclusive, the other not | Length, numeric |
| `> 18`, `>= 18`, `< 50`, `<= 50` | One-sided bound | Length, numeric, date |
| `< TODAY`, `<= TODAY`, `> TODAY`, `>= TODAY` | Relative to the day of validation | Date |
| `>= 2024-01-01` | Relative to a fixed date | Date |

| Cleaning flag | Does |
| --- | --- |
| `trim_whitespace` | Removes leading and trailing spaces |
| `remove_control_chars` | Removes line breaks, tabs and zero-width spaces |
| `normalize_spaces` | Collapses runs of spaces to one |
| `force_upper` / `force_lower` | Changes case |
| `strip_non_numeric` | Keeps digits only |

| Value | Reads as true |
| --- | --- |
| Tick boxes and Yes/No cells | `1`, `TRUE`, `true`, `yes`, `y` in any case; anything else, including blank, is false |

| Data type | Column in the file | Accepts on validation |
| --- | --- | --- |
| `string` | Text, kept as typed | Anything |
| `integer` | Number, whole only | Whole numbers, optional minus |
| `float (2)` | Number | Numbers with up to two decimals |
| `date` | Date cell, shown by its mask | `YYYY-MM-DD` |
| `boolean` | Text | `0`, `1`, `true`, `false` |
| `none` | Text | Anything; use for columns you collect but do not check |

| Data format | Means | Column in the file | Checked on the server |
| --- | --- | --- | --- |
| `dropdown` / `dropdown (dependent)` | Pick from a lookup | Excel list | Membership |
| `email address` | An email | Text, banner hint | Address shape |
| `currency` | An amount, never a code | Number, `#,##0.00` | Up to 2 decimals; numeric range if set |
| `percentage` | A rate | Number, `0.00%`, stored as a fraction | Numeric; numeric range in fractions |
| `date (YYYY-MM-DD)` on `date` | Display mask | Date cell | ISO pattern |
| `date (…)` on `string` | Entry hint | Text, banner hint | Not checked |
