Three edits, all in the seed section of the connector.

**1. New method** — add after `seed_contract_lines` (before `date_mask_regex`):

```ruby
    # ── Seed verdict headline ─────────────────
    # The one-line verdict a page shows above the report. Branches on the roster first so an
    # empty roster reads as "add suppliers", not "fix the file". Commit-neutral: whether a write
    # was attempted is the caller's knowledge, not this method's.
    seed_headline: lambda do |status, error_count, warning_count, unknown_count, roster_empty|
      if roster_empty && unknown_count > 0
        "No suppliers on the roster yet. The seed file names #{unknown_count} supplier(s); add them to continue."
      elsif status == "valid"
        warning_count > 0 ? "Seed file is valid with #{warning_count} warning(s)." : "Seed file is valid."
      else
        "Seed file is not valid; #{error_count} check(s) failed."
      end
    end,
```

**2. `validate_seed` → `output_fields`** — add next to `roster_empty`:

```ruby
          { name: "headline", type: "string",
            hint: "One-line verdict for the page: roster-empty, valid (with warnings), or not valid. Replaces message assembly in recipe formulas." },
```

**3. `validate_seed` → the `report` lambda.** Hoist `status` into a local so the headline can use it, and add the key. The top of the lambda becomes:

```ruby
        report = lambda do |extra|
          lines         = call(:seed_report_lines, checks)
          error_count   = checks.count { |c| c["status"] == "fail" }
          warning_count = checks.count { |c| c["status"] == "warn" }
          status        = error_count > 0 ? "invalid" : "valid"
          {
            "status"             => status,
            "error_count"        => error_count,
            "warning_count"      => warning_count,
            "headline"           => call(:seed_headline, status, error_count, warning_count,
                                         (extra["counts"] || {})["unknown"].to_i, extra["roster_empty"] == true),
```

Everything below `"warnings" =>` is unchanged, and the final `report.call(...)` needs no edit — `headline` is derived from `extra`, so passing `counts` and `roster_empty` as you already do is enough.

Why it hangs together: the two early exits call `report.call({})`, so `extra` is empty, `unknown_count` is 0, `roster_empty` is false, and both are always `invalid` — they get "Seed file is not valid; 1 check(s) failed." without special-casing. The `unknown_count > 0` guard means a blank index column with an empty roster also falls through to the not-valid line instead of claiming "0 suppliers named".

Then INC-01 forwards `headline`, and the WFA-016 `message` formula becomes the one pill — with `+ " Nothing was written."` appended only where `commit` is in scope, if you want to keep that phrase.
