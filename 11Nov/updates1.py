#!/usr/bin/env python
"""
apply_functional_core_patch.py - land the 1_customer additions in the Functional core connector.

What it changes (2026-11-11):
  1. Connector description: eight 1_customer rows, payload 12.x.
  2. customer_key_map    : + supplierManagerEmail, customerLogoFileId, customerLogoDriveUrl.
  3. customer_label_map  : + "supplier manager email", "customer logo" (the uploaded-file row);
                           "customer logo public link" kept for legacy workbooks.
  4. New method drive_file_id_from_link (file ID from any Drive link shape, or a bare ID).
  4b. Primary `_customer.values` path: warning for registry keys this side does not map (drift net).
  5. Grid fallback       : the logo row counts whichever label it carries; supplier manager email is optional,
                           so neither produces a "No row labelled" warning.
  6. Emitted customer hash: + supplier_manager_email, customer_logo_file_id (derived from the link when absent),
                           customer_logo_drive_url; customer_logo_url kept as the legacy public link.
  7. customer_definition : the three new output fields; legacy hint on customer_logo_url.
  8. validate_config     : email check covers supplier_manager_email; customer_logo_url_shape is labelled legacy;
                           new warn-level check customer_logo_file_reference.

Usage (Git Bash on the dev VM; `py -3` if `python` is not on this shell's PATH):
    py -3 apply_functional_core_patch.py path/to/functional_core.rb --check   # dry run: shows what would change
    py -3 apply_functional_core_patch.py path/to/functional_core.rb           # applies; writes <file>.bak first

Two kinds of edit:
  - exact : an anchor block of text, replaced in place. Runs of spaces/tabs match loosely, so alignment
            differences do not break a match; the words must match.
  - block : a method lambda located by name (`<name>: lambda do`) and replaced, together with the comment lines
            directly above it, through its closing `end,` — whatever the body currently holds. --check prints
            the exact lines that would be replaced.
If any edit cannot be located, or is found more than once, nothing is written and the edit is named.
Trailing whitespace is stripped from every line before matching (harmless in Ruby).
"""

import io
import re
import shutil
import sys

EDITS = []


def edit(name, old, new):
    EDITS.append(("exact", name, old.strip("\n"), new.strip("\n")))


def block(name, start_marker, new):
    EDITS.append(("block", name, start_marker, new.strip("\n")))


# ---------------------------------------------------------------------------- 1. description
edit(
    "connector description",
    r'''
  description: "Utility connector for the Supplier Data Collection platform. Handles config parsing, validation, and report generation. " \
               "No external API calls; all logic is pure computation. Reads GAS library exports at schema 1.10/1.11 (payload 12.0): " \
               "1_customer is the seven implementation attributes; 5_lookups has no primary-key column.",
''',
    r'''
  description: "Utility connector for the Supplier Data Collection platform. Handles config parsing, validation, and report generation. " \
               "No external API calls; all logic is pure computation. Reads GAS library exports at schema 1.10 and later (payload 12.x): " \
               "1_customer is the implementation attributes (eight rows once the supplier manager email and the uploaded customer logo " \
               "landed); 5_lookups has no primary-key column.",
''')

# ---------------------------------------------------------------------------- 2. customer_key_map (structural)
block(
    "customer_key_map (replace lambda)",
    "customer_key_map: lambda do",
    r'''
    # ── Customer sheet parser ─────────────────
    # CUSTOMER_FIELDS registry key (as emitted in `_customer.values`) -> connector key. ONE place to flip when a
    # wire-name rename is decided.
    #
    # Schema 1.10 (library 1.11.0): the seven implementation attributes. After 1.10 (Nov 2026): supplierManagerEmail
    # (eighth row; invited to the portal's Supplier managers group by PRV-01 / API-04) and the uploaded logo — the
    # logo row holds the Drive link lib_sdc wrote after the analyst uploaded the image; the library sends it as
    # customerLogoDriveUrl and, when it has it, customerLogoFileId. customerLogoUrl is the legacy public link and
    # stays mapped until the Workato side stops reading it.
    customer_key_map: lambda do
      {
        "clientName"           => "client_name",
        "analystEmail"         => "analyst_email",
        "targetVms"            => "target_vms",
        "reminderDays"         => "reminder_days",
        "expectedDate"         => "expected_date",
        "variantCount"         => "variant_count",
        "customerLogoUrl"      => "customer_logo_url",         # legacy public link
        "customerLogoFileId"   => "customer_logo_file_id",     # uploaded file: Drive file ID
        "customerLogoDriveUrl" => "customer_logo_drive_url",   # uploaded file: Drive link
        "supplierManagerEmail" => "supplier_manager_email"
      }
    end,
''')

# ---------------------------------------------------------------------------- 3 + 4. customer_label_map (structural) + helper
block(
    "customer_label_map (replace lambda) + drive_file_id_from_link (inserted after it)",
    "customer_label_map: lambda do",
    r'''
    # Grid-fallback only: 1_customer label (downcased) -> registry key. Mirrors Labels in 003_Schema.js. Feeds
    # customer_key_map above. Two labels exist for the logo row: the legacy "Customer logo public link" and the
    # "Customer logo" row that holds the uploaded file's Drive link.
    customer_label_map: lambda do
      {
        "analyst email address"     => "analystEmail",
        "customer name"             => "clientName",
        "customer logo public link" => "customerLogoUrl",
        "customer logo"             => "customerLogoDriveUrl",
        "expected completion date"  => "expectedDate",
        "reminder cadence"          => "reminderDays",
        "supplier manager email"    => "supplierManagerEmail",
        "target vms"                => "targetVms",
        "variant count"             => "variantCount"
      }
    end,

    # ── Drive file ID from a link ─────────────
    # The "Customer logo" cell holds the Drive link lib_sdc wrote after the upload. Accepts the shapes Drive hands
    # out (/file/d/<id>/view, /open?id=<id>, uc?id=<id>, /d/<id>) and a bare ID. Returns nil when no ID can be read,
    # so the caller can warn instead of sending an unusable reference downstream.
    drive_file_id_from_link: lambda do |link|
      s = link.to_s.strip
      return nil if s.empty?
      return s if s.match?(/\A[A-Za-z0-9_-]{10,}\z/)
      m = s.match(%r{/d/([A-Za-z0-9_-]{10,})}) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
      m ? m[1] : nil
    end,
''')

# ---------------------------------------------------------------------------- 4b. primary path: unmapped-key drift net
edit(
    "_customer.values: unmapped-key warning",
    r'''
        (sheets["_customer"]["unresolved"] || []).each do |k|
          warnings << { "sheet" => cfg["sheet_name"],
                        "issue" => "Customer field '#{k}' unresolved in the workbook (named range and label both missing); read as nil." }
        end
''',
    r'''
        (sheets["_customer"]["unresolved"] || []).each do |k|
          warnings << { "sheet" => cfg["sheet_name"],
                        "issue" => "Customer field '#{k}' unresolved in the workbook (named range and label both missing); read as nil." }
        end
        # Drift net for the primary path (the grid fallback has one via its label map; this path had none). A registry
        # key the library emits that customer_key_map does not know is discarded with a warning instead of silently
        # reading as nil — the failure mode when the two sides disagree on a new key's name.
        (by_key.keys.map(&:to_s) - call(:customer_key_map).keys).each do |k|
          warnings << { "sheet" => cfg["sheet_name"],
                        "issue" => "Customer field '#{k}' is not mapped on this side (customer_key_map); value discarded." }
        end
''')

# ---------------------------------------------------------------------------- 5. grid fallback missing-row warning
edit(
    "grid fallback: missing-row warning",
    r'''
        (label_map.values - by_key.keys).each do |k|
          warnings << { "sheet" => cfg["sheet_name"], "issue" => "No row labelled for '#{k}'; read as nil." }
        end
''',
    r'''
        # The logo is one row whichever label it carries (legacy public link, or the uploaded file's Drive link), and
        # the supplier manager email is optional; neither should read as a missing row.
        logo_keys = %w[customerLogoUrl customerLogoDriveUrl customerLogoFileId]
        expected  = label_map.values.uniq - logo_keys - %w[supplierManagerEmail]
        expected << "customerLogoDriveUrl" if (logo_keys & by_key.keys).empty?
        (expected - by_key.keys).each do |k|
          warnings << { "sheet" => cfg["sheet_name"], "issue" => "No row labelled for '#{k}'; read as nil." }
        end
''')

# ---------------------------------------------------------------------------- 6. emitted customer hash
edit(
    "emitted customer hash",
    r'''
      # Exactly the seven schema-1.10 attributes, keyed as the Project table and PRV-01 expect them. Retired keys are
      # not emitted at all (not even as nil), so a recipe pill that still points at one fails to resolve at design
      # time instead of silently writing a blank.
      customer = {
        "client_name"       => text.call("clientName"),
        "analyst_email"     => text.call("analystEmail"),
        "target_vms"        => text.call("targetVms"),
        "reminder_days"     => ints.call("reminderDays"),
        "expected_date"     => opt.call("expectedDate"),
        "variant_count"     => int.call("variantCount") || 0,
        "customer_logo_url" => opt.call("customerLogoUrl")
      }
''',
    r'''
      # The schema-1.10 attributes plus the three keys that landed after it, keyed as the Project table and PRV-01
      # expect them. Retired keys are not emitted at all (not even as nil), so a recipe pill that still points at one
      # fails to resolve at design time instead of silently writing a blank.
      #
      # The logo arrives as an uploaded file now: customerLogoDriveUrl (the Drive link in the "Customer logo" cell)
      # and, when the library sends it, customerLogoFileId. The ID is derived from the link when only the link is
      # present, so the wire shape is the same whichever the library emits. customerLogoUrl is the legacy public
      # link; it is passed through unchanged until the Workato side stops reading it.
      logo_drive_url = opt.call("customerLogoDriveUrl")
      logo_file_id   = opt.call("customerLogoFileId") || call(:drive_file_id_from_link, logo_drive_url)
      customer = {
        "client_name"             => text.call("clientName"),
        "analyst_email"           => text.call("analystEmail"),
        "target_vms"              => text.call("targetVms"),
        "reminder_days"           => ints.call("reminderDays"),
        "expected_date"           => opt.call("expectedDate"),
        "variant_count"           => int.call("variantCount") || 0,
        "customer_logo_url"       => opt.call("customerLogoUrl"),
        "customer_logo_file_id"   => logo_file_id,
        "customer_logo_drive_url" => logo_drive_url,
        "supplier_manager_email"  => opt.call("supplierManagerEmail")
      }
''')

# ---------------------------------------------------------------------------- 7. customer_definition
edit(
    "customer_definition: comment",
    r'''
          # The seven schema-1.10 implementation attributes. Every earlier key (application_title, drive_folder_id,
          # submission_deadline, wfa_instructions, pre_invite_message_body, the incumbent_* / seed_* block,
          # reminder_days_1..3) is gone from the wire; see customer_key_map.
          { name: "client_name",             type: "string" },
''',
    r'''
          # The seven schema-1.10 implementation attributes plus the three post-1.10 keys (supplier manager email,
          # uploaded logo file ID and Drive link). Every earlier key (application_title, drive_folder_id,
          # submission_deadline, wfa_instructions, pre_invite_message_body, the incumbent_* / seed_* block,
          # reminder_days_1..3) is gone from the wire; see customer_key_map.
          { name: "client_name",             type: "string" },
''')

edit(
    "customer_definition: new fields",
    r'''
          { name: "customer_logo_url",       type: "string",  optional: true,
            hint: "Public http(s) URL of the customer logo image, or nil when the analyst left the field blank. " \
                  "Shape-checked (warn) by validate_config; reachability is not checked." }
        ]
      end
    },
''',
    r'''
          { name: "customer_logo_url",       type: "string",  optional: true,
            hint: "LEGACY. Public http(s) URL of the customer logo image from the pre-upload 'Customer logo public link' row, " \
                  "or nil. Shape-checked (warn) by validate_config; reachability is not checked. Superseded by " \
                  "customer_logo_file_id / customer_logo_drive_url." },
          { name: "customer_logo_file_id",   type: "string",  optional: true,
            hint: "Drive file ID of the uploaded customer logo (the copy lib_sdc landed in the engagement folder and shared " \
                  "with the integration principal), or nil. Derived from customer_logo_drive_url when the library sends " \
                  "only the link. PRV-01 fetches it through the Drive connection." },
          { name: "customer_logo_drive_url", type: "string",  optional: true,
            hint: "Drive link of the uploaded customer logo as written in the 1_customer 'Customer logo' cell, or nil." },
          { name: "supplier_manager_email",  type: "string",  optional: true,
            hint: "Email of the internal supplier manager for this engagement, or nil. Invited to the portal's " \
                  "Supplier managers group by PRV-01 at provisioning and by API-04 on demand. Format-checked (warn) by validate_config." }
        ]
      end
    },
''')

# ---------------------------------------------------------------------------- 8. validate_config
edit(
    "validate_config: email_format_valid",
    r'''
        bad_emails << { "entity" => "customer", "name" => "analyst_email", "issue" => "invalid format" } if customer["analyst_email"].present? && !customer["analyst_email"].match?(email_regex)
''',
    r'''
        bad_emails << { "entity" => "customer", "name" => "analyst_email", "issue" => "invalid format" } if customer["analyst_email"].present? && !customer["analyst_email"].match?(email_regex)
        bad_emails << { "entity" => "customer", "name" => "supplier_manager_email", "issue" => "invalid format" } if customer["supplier_manager_email"].present? && !customer["supplier_manager_email"].match?(email_regex)
''')

edit(
    "validate_config: customer_required_attributes comment",
    r'''
        #   Mirrors the `required: true` entries of the library's CUSTOMER_FIELDS (the starred rows on 1_customer).
        #   Schema 1.10: client_name, analyst_email, target_vms, expected_date and a non-empty reminder_days. The
        #   library also requires variant_count (checked by variant_count_matches) and customer_logo_url (shape-checked
        #   below; blank is tolerated here so an engagement without a logo can still provision).
        required_customer = %w[client_name analyst_email target_vms expected_date]
''',
    r'''
        #   Mirrors the `required: true` entries of the library's CUSTOMER_FIELDS (the starred rows on 1_customer).
        #   Schema 1.10: client_name, analyst_email, target_vms, expected_date and a non-empty reminder_days. The
        #   library also requires variant_count (checked by variant_count_matches) and customer_logo_url (shape-checked
        #   below; blank is tolerated here so an engagement without a logo can still provision).
        #   supplier_manager_email is optional (format-checked by email_format_valid); if the library makes that row
        #   required, append it to required_customer and nothing else changes.
        required_customer = %w[client_name analyst_email target_vms expected_date]
''')

edit(
    "validate_config: logo checks",
    r'''
        # customer_logo_url_shape (warning)
        #   Preflight 5d applies the same test before the payload leaves the workbook; this is the receiver's copy.
        #   A URL that does not resolve to an image is not detectable here and surfaces in the email render.
        logo = customer["customer_logo_url"].to_s.strip
        logo_ok = logo.empty? || logo.match?(%r{\Ahttps?://\S+\z}i)
        checks << {
          "check_name" => "customer_logo_url_shape",
          "status"     => logo_ok ? "pass" : "warn",
          "message"    => logo_ok ? (logo.empty? ? "No customer logo configured" : "Customer logo link is an http(s) URL") :
                            "Customer logo link is not an http(s) URL",
          "details"    => logo_ok ? [] : [{ "entity" => "customer", "name" => "customer_logo_url",
                                            "issue" => "'#{logo}' is not an http(s) URL; emails will render without a logo." }]
        }
''',
    r'''
        # customer_logo_url_shape (warning) — LEGACY public-link row
        #   Preflight 5d applies the same test before the payload leaves the workbook; this is the receiver's copy.
        #   A URL that does not resolve to an image is not detectable here and surfaces in the email render.
        #   Workbooks migrated to the uploaded-logo row no longer send this field; blank passes.
        logo = customer["customer_logo_url"].to_s.strip
        logo_ok = logo.empty? || logo.match?(%r{\Ahttps?://\S+\z}i)
        checks << {
          "check_name" => "customer_logo_url_shape",
          "status"     => logo_ok ? "pass" : "warn",
          "message"    => logo_ok ? (logo.empty? ? "No legacy customer logo link" : "Legacy customer logo link is an http(s) URL") :
                            "Legacy customer logo link is not an http(s) URL",
          "details"    => logo_ok ? [] : [{ "entity" => "customer", "name" => "customer_logo_url",
                                            "issue" => "'#{logo}' is not an http(s) URL; emails will render without a logo." }]
        }

        # customer_logo_file_reference (warning) — uploaded-logo row
        #   The Drive link in the "Customer logo" cell and the file ID the Workato side fetches through the Drive
        #   connection. Blank is fine (no logo). A link that yields no file ID is the one shape nothing downstream can
        #   use, so it warns here instead of failing inside PRV-01. Whether the integration principal can read the
        #   file is not checked here (no external calls); that surfaces in the PRV-01 copy step.
        logo_link = customer["customer_logo_drive_url"].to_s.strip
        logo_id   = customer["customer_logo_file_id"].to_s.strip
        logo_ref_issue =
          if logo_link.empty? && logo_id.empty?
            nil
          elsif logo_id.empty?
            "'#{logo_link}' is not a Drive link a file ID can be read from; upload the logo again."
          elsif !logo_id.match?(/\A[A-Za-z0-9_-]{10,}\z/)
            "file ID '#{logo_id}' does not look like a Drive file ID."
          end
        checks << {
          "check_name" => "customer_logo_file_reference",
          "status"     => logo_ref_issue ? "warn" : "pass",
          "message"    => if logo_ref_issue then "Customer logo file reference is not usable"
                          elsif logo_id.empty? then "No uploaded customer logo"
                          else "Uploaded customer logo file reference present"
                          end,
          "details"    => logo_ref_issue ? [{ "entity" => "customer", "name" => "customer_logo_drive_url",
                                              "issue" => logo_ref_issue }] : []
        }
''')


# ---------------------------------------------------------------------------- driver

def normalize(text):
    return "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"))


def loose_pattern(anchor):
    """Regex for an anchor block where every run of spaces/tabs matches any run of spaces/tabs."""
    lines = []
    for line in normalize(anchor).split("\n"):
        pieces = re.split(r"[ \t]+", line)
        lines.append(r"[ \t]+".join(re.escape(p) for p in pieces))
    return "\n".join(lines)


def apply_exact(text, name, old, new):
    hits = list(re.finditer(loose_pattern(old), text))
    if len(hits) == 1:
        return text[:hits[0].start()] + normalize(new) + text[hits[0].end():], None
    if not hits:
        return text, f"MISSING   {name}: anchor text not found"
    return text, f"AMBIGUOUS {name}: anchor text found {len(hits)} times"


def apply_block(text, name, marker, new, check_only):
    lines = text.split("\n")
    idx = [i for i, l in enumerate(lines) if marker in l]
    if len(idx) != 1:
        return text, f"{'MISSING  ' if not idx else 'AMBIGUOUS'} {name}: marker '{marker}' found {len(idx)} times"
    i = idx[0]
    indent = len(lines[i]) - len(lines[i].lstrip())
    j = next((k for k in range(i + 1, len(lines))
              if lines[k].strip() == "end," and len(lines[k]) - len(lines[k].lstrip()) == indent), None)
    if j is None:
        return text, f"MISSING   {name}: no closing 'end,' after the marker"
    top = i
    while top > 0 and lines[top - 1].lstrip().startswith("#"):   # take the comment block above with it
        top -= 1
    if check_only:
        print(f"           will replace lines {top + 1}-{j + 1}:")
        for l in lines[top:j + 1]:
            print("           | " + l)
    lines[top:j + 1] = normalize(new).split("\n")
    return "\n".join(lines), None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    path = args[0]

    with io.open(path, "r", encoding="utf-8") as fh:
        text = normalize(fh.read())

    problems = []
    for kind, name, old, new in EDITS:
        if kind == "exact":
            text, problem = apply_exact(text, name, old, new)
        else:
            text, problem = apply_block(text, name, old, new, check_only)
        if problem:
            problems.append(problem)
        else:
            print(f"ok        {name}")

    if problems:
        print("\n" + "\n".join(problems))
        print("\nNothing written. Apply the named edit(s) by hand from the EDITS in this script, then re-run.")
        sys.exit(1)

    if check_only:
        print("\n--check: all edits locate cleanly; run again without --check to apply.")
        return

    shutil.copyfile(path, path + ".bak")
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text if text.endswith("\n") else text + "\n")
    print(f"\nwritten {path} (backup at {path}.bak)")


if __name__ == "__main__":
    main()
