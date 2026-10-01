# SDC config ↔ TPL-02 ↔ Functional core — change set (Oct 2026)

Oct 1, 2026 · @Emily Cabaniss

## Summary

Four components read the same `Data type` / `Data format` pair and act on it differently. The governing rule after these changes: **the type decides a column's shape** (string → Excel Text, date → date column with ISO on the wire, integer / float (2) / currency / percentage → number), and **the format label only picks a mask inside that shape**. One predicate expresses this on each side (`_type_shape` in TPL-02, `field_shape` in the connector) and the two must stay identical.

| Component | Change | Status | Fixes |
| --- | --- | --- | --- |
| TPL-02 (Python) | `_TEXT_FORMAT`, `_type_shape`, `_display_number_format`, `_advisory_hint`, `_coerce_for_plan` | required | leading zeros and long IDs lost in string columns; string fields with a `date (…)` label rendered as dates |
| Functional core | `field_shape`, `ordering_domain`, ordering-verb rewrite, numeric-range gate | required | ordering rules compare dates by year only; `numeric_field_validation` ignored on currency / percentage |
| Functional core | `date_mask_regex` + `check_data_format(value, field)`, `err_regex` pick list, three `validate_config` checks, `verb_error_code` | optional | server meaning for `date (…)` on string fields; vocabulary gaps; bad configs stopped at provisioning |
| master\_config 1.0.0 | `contractor_birth_mmdd`, `currency_code`, `_error_translation`, `_mapping` | required (two field rows) / optional (tables) | two fields that can never be filled validly today |
| VAL-01, TPL-03, UTL-04, CFG-01 | none | — | — |

Release order: workbook field fixes and TPL-02 together (a rebuilt template picks them up); the required connector edits on their own schedule (they take effect at the next upload on every frozen model); the optional connector edits whenever. If the optional `check_data_format` change ships, the `contractor_birth_mmdd` fix must land first or in the same release.

## TPL-02 Build XLSX template (Python)

Five edits, all in the PLAN phase. Nothing in RENDER changes: `render_data_sheet` already sets the column default from `number_format`, `render_records` already stamps it on prefilled cells, and `_build_advisory_validation` / `_value_kind` already read `_type_shape`.

**1. Add beside the other module constants**

```python
_TEXT_FORMAT = "@"   # Excel Text: keeps typed input verbatim (leading zeros, long IDs, "03/15")
```

**2. Replace `_type_shape` whole**

```python
def _type_shape(field):
    """
    The one reading of data_type / data_format the Data sheet acts on: (is_numeric, is_integer, is_date).
    Shared by the advisory validation, _display_number_format and _value_kind so the in-cell check, the
    display format and the prefill coercion cannot drift apart. Mirrors the connector's field_shape;
    changes to one must be mirrored in the other.
    Only the TYPE makes a column numeric or a date; the data_format label picks a mask within that shape.
    'currency' / 'percentage' are the one exception: numeric by label, because they carry data_type
    'string' in the model yet are numbers in practice.
    """
    label     = _format_label(field)
    data_type = str(field.get("data_type") or "").strip().lower()
    is_numeric = data_type in ("integer", "float (2)") or label in ("currency", "percentage")
    is_integer = data_type == "integer"
    is_date    = data_type == "date"
    return is_numeric, is_integer, is_date
```

**3. Replace `_display_number_format` whole**

```python
def _display_number_format(field):
    """
    DISPLAY (number) format for a column. Display only: governs how Excel RENDERS a value -- never what
    is accepted (the DV) nor what the server ingests (the stored value). Returns an Excel format code
    or None. Text columns get Excel's Text format so the cell holds what was typed.
    """
    is_numeric, _, is_date = _type_shape(field)
    label = _format_label(field)

    if is_date:
        m = _DATE_MASK.search(field.get("data_format") or "")
        return m.group(1).strip().lower() if m else _DEFAULT_DATE_FORMAT

    if label == "percentage":
        m = _FLOAT_PREC.search(str(field.get("data_type") or "").strip().lower())   # 'float (2)' -> 2
        decimals = int(m.group(1)) if m else 2
        return "0%" if decimals <= 0 else "0.{0}%".format("0" * decimals)

    if label == "currency":
        return "#,##0.00"   # symbol intentionally omitted -- locale/currency unknown; cosmetic only

    if not is_numeric:
        return _TEXT_FORMAT  # string / email / boolean / unshaped, incl. a date (...) label on a string field

    return None
```

**4. Replace `_advisory_hint` whole**

```python
def _advisory_hint(field):
    """
    Optional human-readable guidance appended to the locked instruction banner for constraints Excel
    cannot block in-cell. Generic and parse-free; the analyst's description stays the primary guidance
    lever and VAL-01 stays the authority. Extend by adding cases.
    """
    label = _format_label(field)
    if label == "email address":
        return "Must be a valid email address (e.g. name@example.com)."
    if label.startswith("date") and not _type_shape(field)[2]:
        # A date (<mask>) label on a STRING field: the column is text; tell the supplier the shape.
        m = _DATE_MASK.search(field.get("data_format") or "")
        if m:
            return "Enter as text in the form {0}.".format(m.group(1).strip().upper())
    return None
```

**5. In `_coerce_for_plan`, insert these lines before the existing `if not isinstance(value, str): return value`**

```python
    if plan.value_kind == "text":
        # A Text column holds what was typed. A JSON number prefilled into it must land as a string,
        # or Excel shows a number in a text cell and drops any leading zero on the way.
        return value if isinstance(value, str) else str(value)
```

(`kind = plan.value_kind` is assigned a few lines lower in the current body; either read `plan.value_kind` directly here, as above, or move that assignment up.)

**Docstring touch-up (no behaviour).** The module docstring's `Sheet geometry` block and the `_type_shape` comment in `_build_advisory_validation` can say "the type decides the column shape; the label picks the mask". Not required.

What the change produces per field type:

| Data type | Column default format | Advisory DV | Prefill coercion |
| --- | --- | --- | --- |
| string (any format but currency / percentage) | `@` | none | value as string |
| date | mask from label, else `yyyy-mm-dd` | date ≥ 1900-01-01 | ISO / US date strings → `date` |
| integer | none | `ISNUMBER` and integer | `int` |
| float (2) | none | `ISNUMBER` | `float` |
| currency (any type) | `#,##0.00` | `ISNUMBER` | `float` |
| percentage (any type) | `0.00%` | `ISNUMBER` | `"12.5%"` → `0.125`; `"12.5"` → `12.5` |

## Functional core connector — required

Three edits in `methods`, then two in `validate_rows`. Both runtime behaviours they fix are read from `cfg_fields` in the frozen model at upload time, so they apply to every project at its next upload with no re-provisioning.

**1. Add two methods** (anywhere in `methods`; next to `check_data_type` is natural)

```ruby
    # ── Field shape ───────────────────────────
    # The one reading of data_type / data_format the validator acts on. Mirrors TPL-02 _type_shape;
    # the two MUST agree or template and server disagree on what a column is ('currency' carries
    # data_type 'string' in the model yet is numeric in practice). Changes to one must be mirrored.
    field_shape: lambda do |field|
      data_type = field["data_type"].to_s.strip.downcase
      label     = field["data_format"].to_s.strip.downcase
      {
        "numeric" => %w[integer float\ (2)].include?(data_type) || %w[currency percentage].include?(label),
        "integer" => data_type == "integer",
        "date"    => data_type == "date"
      }
    end,

    # ── Ordering-rule domain ──────────────────
    # How the four ordering verbs compare target to condition: "date" when both fields are date-typed
    # (lexicographic on YYYY-MM-DD, as evaluate_date_interval), "numeric" when both are numeric-shaped,
    # nil when the pair cannot be ordered (validate_config fails it; validate_rows falls back to numeric
    # for models frozen before that check existed).
    ordering_domain: lambda do |target_field, condition_field|
      t = call(:field_shape, target_field)
      c = call(:field_shape, condition_field)
      if    t["date"]    && c["date"]    then "date"
      elsif t["numeric"] && c["numeric"] then "numeric"
      end
    end,
```

**2. `validate_rows`, Phase 2 check 6 — replace the gate line**

Current:

```ruby
          if f["numeric_field_validation"].present? && %w[integer float\ (2)].include?(f["data_type"])
```

New:

```ruby
          if f["numeric_field_validation"].present? && call(:field_shape, f)["numeric"]
```

**3. `validate_rows`, Phase 4 within-submission dispatch — replace the four ordering `when` branches**

Current (delete all four):

```ruby
          when "Must be greater than"
            failed = t_val.to_f <= c_val.to_f if t_val.present? && c_val.present?
            error_code = "err_greater_than"
          when "Must be greater than or equal to"
            failed = t_val.to_f < c_val.to_f if t_val.present? && c_val.present?
            error_code = "err_greater_than_equal"
          when "Must be less than"
            failed = t_val.to_f >= c_val.to_f if t_val.present? && c_val.present?
            error_code = "err_less_than"
          when "Must be less than or equal to"
            failed = t_val.to_f > c_val.to_f if t_val.present? && c_val.present?
            error_code = "err_less_than_equal"
```

New (one branch in their place):

```ruby
          when "Must be greater than", "Must be greater than or equal to",
               "Must be less than",    "Must be less than or equal to"
            error_code = { "Must be greater than"             => "err_greater_than",
                           "Must be greater than or equal to" => "err_greater_than_equal",
                           "Must be less than"                => "err_less_than",
                           "Must be less than or equal to"    => "err_less_than_equal" }[rule["rule"]]
            # Only compare values that already passed their type check; a malformed date or number was
            # flagged err_data_type in Phase 1 and would only add a spurious second error here.
            if t_val.present? && c_val.present? && c_field &&
               call(:check_data_type, t_val, target_field["data_type"]) &&
               call(:check_data_type, c_val, c_field["data_type"])
              domain = call(:ordering_domain, target_field, c_field) || "numeric"
              cmp    = domain == "date" ? (t_val.to_s.strip <=> c_val.to_s.strip) : (t_val.to_f <=> c_val.to_f)
              failed = case rule["rule"]
                       when "Must be greater than"             then cmp <= 0
                       when "Must be greater than or equal to" then cmp <  0
                       when "Must be less than"                then cmp >= 0
                       else                                         cmp >  0
                       end
            end
```

`failed` and `error_code` are already initialised to `false` / `nil` above the `case`, so the no-compare path still falls through to the existing `if failed` block unchanged. `Must match` / `Must not match` stay as they are.

## Functional core connector — optional

Each item stands alone. None is needed for the TPL-02 change to work.

**A. Server meaning for a `date (…)` label on a string field.** Without this, the label is a template hint only and `_mapping`'s three non-ISO date formats stay decorative. With it, a string field labelled `date (mm/dd)` must contain `\d{2}/\d{2}`. Prerequisite: the `contractor_birth_mmdd` workbook fix below, or that field starts rejecting `0315`.

Add a method:

```ruby
    # ── Date-mask text shape ──────────────────
    # Shape implied by a date (<mask>) label on a STRING field. A date-typed field never reaches this:
    # its wire value is ISO whatever the mask (the mask is the template's display format only).
    date_mask_regex: lambda do |data_format|
      { "date (yyyy-mm-dd)" => /\A\d{4}-\d{2}-\d{2}\z/,
        "date (yyyy/mm/dd)" => /\A\d{4}\/\d{2}\/\d{2}\z/,
        "date (mm/dd)"      => /\A\d{2}\/\d{2}\z/,
        "date (dd/mm)"      => /\A\d{2}\/\d{2}\z/ }[data_format.to_s.strip.downcase]
    end,
```

Replace `check_data_format` whole (signature changes from `|value, data_format|` to `|value, field|`):

```ruby
    # ── Data format check ─────────────────────
    check_data_format: lambda do |value, field|
      data_format = field["data_format"].to_s.strip
      return true if value.blank? || data_format.blank?
      v = value.to_s.strip
      if data_format.downcase.start_with?("date")
        return v.match?(/\A\d{4}-\d{2}-\d{2}\z/) if field["data_type"].to_s.downcase == "date"
        rx = call(:date_mask_regex, data_format)
        return rx ? v.match?(rx) : true
      end
      case data_format.downcase
      when "email address" then v.match?(/\A[^@\s]+@[^@\s]+\.[^@\s]+\z/)
      when "currency"      then v.match?(/\A-?\d+(\.\d{1,2})?\z/)
      when "percentage"    then v.match?(/\A-?\d+(\.\d+)?\z/)
      else true  # dropdown, dropdown (dependent) checked via lookup membership
      end
    end,
```

One caller, `validate_rows` Phase 1 check 4: `call(:check_data_format, val, f["data_format"])` → `call(:check_data_format, val, f)`. Side effect worth having: the current branch compares `"date (YYYY-MM-DD)"` case-sensitively, so today only that exact spelling is checked.

**B. `err_regex` in the pick list.** In `pick_lists.error_codes`, add `%w[err_regex err_regex]` after `err_date_constraint`. Cosmetic: nothing binds this pick list today.

**C. Three `validate_config` checks.** Insert before `# CALCULATE AND RETURN`.

```ruby
        # ordering_rule_fields_comparable
        ordering_verbs = ["Must be greater than", "Must be greater than or equal to",
                          "Must be less than",    "Must be less than or equal to"]
        by_name = fields.group_by { |f| f["field_name"] }.transform_values(&:first)
        bad_ordering = rules.select { |r| ordering_verbs.include?(r["rule"]) }.map do |r|
          t = by_name[r["target_field_name"]]; c = by_name[r["condition_field_name"]]
          next if t.nil? || c.nil? || call(:ordering_domain, t, c)   # missing fields already fail upstream
          shape = ->(f) { "#{f['field_name']} (#{[f['data_type'], f['data_format']].compact.join(', ')})" }
          { "entity" => "rule", "name" => r["target_field_name"],
            "issue"  => "'#{r['rule']}' needs both fields date-typed or both numeric; got #{shape.call(t)} vs #{shape.call(c)}" }
        end.compact
        checks << {
          "check_name" => "ordering_rule_fields_comparable",
          "status"     => bad_ordering.empty? ? "pass" : "fail",
          "message"    => bad_ordering.empty? ? "All ordering rules compare like with like" :
                            "#{bad_ordering.size} ordering rule(s) compare incomparable fields",
          "details"    => bad_ordering
        }

        # numeric_format_type_consistent
        odd_currency = fields.select { |f| f["data_format"].to_s.downcase == "currency" &&
                                           !%w[float\ (2) integer].include?(f["data_type"].to_s.downcase) }
        checks << {
          "check_name" => "numeric_format_type_consistent",
          "status"     => odd_currency.empty? ? "pass" : "warn",
          "message"    => odd_currency.empty? ? "Currency fields are numeric-typed" :
                            "#{odd_currency.size} currency field(s) not numeric-typed",
          "details"    => odd_currency.map { |f|
            { "entity" => "field", "name" => f["field_name"],
              "issue"  => "data_format 'currency' is an amount: it renders as a number in the template and is " \
                          "checked as one on the server. Set data_type to 'float (2)', or clear data_format " \
                          "if this field is a currency code." } }
        }

        # date_format_on_date_type_has_year
        partial_dates = fields.select { |f| f["data_type"].to_s.downcase == "date" &&
                                            %w[date\ (mm/dd) date\ (dd/mm)].include?(f["data_format"].to_s.downcase) }
        checks << {
          "check_name" => "date_format_on_date_type_has_year",
          "status"     => partial_dates.empty? ? "pass" : "warn",
          "message"    => partial_dates.empty? ? "Every date-typed field carries a year" :
                            "#{partial_dates.size} date-typed field(s) use a partial-date format",
          "details"    => partial_dates.map { |f|
            { "entity" => "field", "name" => f["field_name"],
              "issue"  => "'#{f['data_format']}' has no year; Excel will store a year the supplier never typed " \
                          "and the server receives YYYY-MM-DD. Use data_type 'string' for a partial date." } }
        }
```

Percentage is deliberately left out of `numeric_format_type_consistent`: Excel stores a `0.00%` cell as a fraction (`12.5` typed → `0.125`), and `float (2)` would reject the third decimal. Decide the percentage unit before adding it.

**D. Dead auto-generate in `parse_rules_sheet`.** `translation = error_translations.find { |t| t["error_code"] == rule["rule"] }` compares a code to a verb and never matches; `error_message` always arrives nil and the runtime fallback in `resolve_error_message` does the work. Harmless. If you want parse-time defaults, add a `verb_error_code` method mapping the eleven verbs to their codes (the `_mapping` rule\_name → backend\_error\_code table) and look up `call(:verb_error_code)[rule["rule"]]`.

## Master config workbook (master\_config\_1\_0\_0.xlsx)

Two `4_fields` rows are required; the table edits are vocabulary hygiene.

**4\_fields (required)**

| Field name | Today | Change | Why |
| --- | --- | --- | --- |
| `contractor_birth_mmdd` | string · `date (mm/dd)` · `exact: 4` · regex `^\d{4}$` | clear **Data format**; keep the rest | the regex says the VMS wants `0315`; with the label the template made it a date column (and optional edit A would demand `03/15`) |
| `currency_code` | string · `currency` · regex `^[A-Z]{3}$` | clear **Data format**; keep the regex (or bind a lookup of ISO codes) | `currency` means an amount on both sides: the template blocks `USD` with ISNUMBER and the server fails it on `err_standard_format` |

**\_error\_translation (optional)**

| Row | Change |
| --- | --- |
| new | `err_regex` · `The value in '{field_name}' does not match the required pattern. Provided: '{provided_value}'.` · `field_name, provided_value` |
| 11 | delete: duplicate of row 10 (`err_date_constraint`) |
| 5 | `{expected_data_type}` → `{expected_value}` (the placeholder list already says `expected_value`) |
| 8 | `{provided_length} characters long` → reword around `{provided_value}`; nothing supplies `provided_length` |

Note: `validate_rows` writes every single-field message inline and only consults `cfg_error_messages` for cross-field rules, so rows 2–11 are read by whatever renders by code outside the connector, if anything. The placeholder fixes matter only there.

**\_mapping (optional)**

| Column | Change |
| --- | --- |
| `rule_name` / `backend_error_code` / `type` | add `err_regex` · `err_regex` · `single-field`; remove the duplicate `err_date_constraint` row (rows 15–16) |
| `format_descr` for `date (mm/dd)` | "Date structured as month and year." → "month and day" |
| `data_format` | `percentage` appears twice (rows 10–11); keep one. Keep `date (dd/mm)`, `date (mm/dd)`, `date (yyyy/mm/dd)` only if optional edit A ships; otherwise they do nothing on the server |

**4\_complex\_validations**, no change. Row 18's Condition value is the number `1.0` (billing\_strategy = `1`); `c_val.to_s == "1.0"` will not equal `"1"`. Not in scope here, but worth typing that cell as text.

## Recipes: no change

| Recipe | Checked | Why it stands |
| --- | --- | --- |
| VAL-01 Validate supplier input | step 19 (extract), step 28 | reads with `values_only=True`; `_json_default` emits every `datetime` as ISO and passes strings through — Text cells arrive verbatim, date cells as `YYYY-MM-DD`, which is the contract above |
| TPL-03 Rebuild supplier form submission as XLSX | all steps | forwards `records_json` to TPL-02; the `_coerce_for_plan` text branch covers its values |
| UTL-04 Unprotect worksheet | step 8 | `load_workbook` → clear protection → `save`; openpyxl preserves number formats, so an unprotected copy keeps its Text columns |
| CFG-01 Validate config | step 6 | 300-character shim around `validate_config`; new checks surface through the existing `checks[]` output |

INC-01 / INC-02 were not uploaded; they call TPL-02 with `records_json` from the seed extract, whose values are already strings, so the same coercion branch applies.

## Impacts, tests, guide wording

**Behaviour changes by surface**

| Change | Takes effect | Who notices |
| --- | --- | --- |
| string columns become Text | next template build (TPL-01 / TPL-03 / INC-02 rebuild) | suppliers keep leading zeros and long IDs; `contractor_birth_mmdd` becomes a plain text column |
| ordering verbs compare dates | next upload, every frozen model | any project with a greater/less rule on two date fields flips from year-only to correct; same-year pairs stop failing |
| numeric range on currency / percentage | next upload, every frozen model | a `numeric_field_validation` that was silently ignored now enforces |
| type gate before ordering compare | next upload | one error per malformed value instead of two |
| `ordering_rule_fields_comparable` (fail) | next provisioning / re-version | a config with an ordering rule on a string field stops freezing |
| optional A: `date (…)` on string fields checked | next upload | `contractor_birth_mmdd` rejects `0315` unless its format is cleared first |

**Before shipping the connector**

- [ ] Query CFG\_Rule for the four ordering verbs across live versions; list which target/condition pairs are dates (blast radius of item 1)
- [ ] Query CFG\_Field for `data_format` in (currency, percentage) with a non-blank `numeric_field_validation` (blast radius of item 3)
- [ ] Decide the percentage unit: Excel stores `12.5` typed into a `0.00%` cell as `0.125`, so a range must be written `[0, 1]`, and the form channel must store the same fraction. Check what FRM-01 writes for a percentage field
- [ ] Confirm which recipes or pages read `_error_translation` / `cfg_error_messages` for single-field codes (decides whether the placeholder fixes matter)

**Before shipping TPL-02 (five minutes in Excel on a built template)**

- [ ] Type `0315` into a string column under sheet protection: the cell keeps `0315` left-aligned as text
- [ ] Paste a numeric cell from another workbook into that column: see whether the Text format survives (`formatCells` is denied under protection by default). If it does not, `315` reaches VAL-01 and the field's regex rejects it — loud, not silent
- [ ] Upload the file through VAL-01 and confirm `rows_json` carries `"0315"` as a string

**Analyst guide wording**

- Data type decides what kind of column the supplier gets: `string` is free text and keeps exactly what is typed (including leading zeros); `date` is a date picker-style cell stored as YYYY-MM-DD; `integer`, `float (2)`, `currency` and `percentage` are numbers.
- `currency` and `percentage` are numeric formats, an amount or a rate, not a code. For an ISO currency code leave Data format blank and use a dropdown or a regex.
- `date (…)` on a `date` field changes only how Excel displays the date; the system always receives YYYY-MM-DD. `date (mm/dd)` and `date (dd/mm)` have no year, so use `string` for a partial date.
- The four ordering verbs (greater than, greater than or equal to, less than, less than or equal to) compare numbers when both fields are numeric and dates when both fields are `date`. Anything else is a configuration error.
- A `Field input validation` regex failure respects the field's `Strict?` flag, like length, range and date constraints; required, type, format, lookup and uniqueness failures are always strict.
- A `numeric_field_validation` on a `percentage` field is written in the stored unit (fractions), pending the decision above.
