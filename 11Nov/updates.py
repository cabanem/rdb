#!/usr/bin/env python
"""
apply_functional_core_patch.py - land the 1_customer additions in the Functional core connector.

What it changes (2026-11-11):
  1. Connector description: eight 1_customer rows, payload 12.x.
  2. customer_key_map    : + supplierManagerEmail, customerLogoFileId, customerLogoDriveUrl.
  3. customer_label_map  : + "supplier manager email", "customer logo" (the uploaded-file row);
                           "customer logo public link" kept for legacy workbooks.
  4. New method drive_file_id_from_link (file ID from any Drive link shape, or a bare ID).
  5. Grid fallback       : the logo row counts whichever label it carries; supplier manager email is optional,
                           so neither produces a "No row labelled" warning.
  6. Emitted customer hash: + supplier_manager_email, customer_logo_file_id (derived from the link when absent),
                           customer_logo_drive_url; customer_logo_url kept as the legacy public link.
  7. customer_definition : the three new output fields; legacy hint on customer_logo_url.
  8. validate_config     : email check covers supplier_manager_email; customer_logo_url_shape is labelled legacy;
                           new warn-level check customer_logo_file_reference.

Usage (Git Bash on the dev VM):
    python apply_functional_core_patch.py path/to/functional_core.rb --check   # dry run: reports which anchors match
    python apply_functional_core_patch.py path/to/functional_core.rb           # applies; writes <file>.bak first

Every edit is an exact-text replacement on a unique anchor. If any anchor is missing or ambiguous the script
stops before writing and names the edit, so a file that has drifted from the 2026-11-11 text is never half-patched.
Trailing whitespace is stripped from every line before matching (harmless in Ruby) so a copy-paste that lost or
gained trailing spaces still matches.
"""

import io
import shutil
import sys

EDITS = []


def edit(name, old, new):
    EDITS.append((name, old.strip("\n"), new.strip("\n")))


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

# ---------------------------------------------------------------------------- 2 + 3 + 4. key map, label map, helper
edit(
    "customer_key_map + customer_label_map + drive_file_id_from_link",
    r'''
    # Schema 1.10 (library 1.11.0): 1_customer is exactly the seven implementation attributes. The six seed-data
    # keys and the two supplier-messaging keys left at 1.9; applicationName, outputDriveFolderId and
    # lastDayForSubmission left at 1.10; customerLogoUrl arrived. Seeding is configured in the portal now
    # (validate_seed takes index_key from its caller), so none of the retired keys has a reader on this side.
    customer_key_map: lambda do
      {
        "clientName"      => "client_name",
        "analystEmail"    => "analyst_email",
        "targetVms"       => "target_vms",
        "reminderDays"    => "reminder_days",
        "expectedDate"    => "expected_date",
        "variantCount"    => "variant_count",
        "customerLogoUrl" => "customer_logo_url"
      }
    end,

    # Grid-fallback only: 1_customer label (downcased, schema 1.10 wording) -> registry key.
    # Mirrors Labels in 003_Schema.js. Feeds customer_key_map above.
    customer_label_map: lambda do
      {
        "analyst email address"     => "analystEmail",
        "customer name"             => "clientName",
        "customer logo public link" => "customerLogoUrl",
        "expected completion date"  => "expectedDate",
        "reminder cadence"          => "reminderDays",
        "target vms"                => "targetVms",
        "variant count"             => "variantCount"
      }
    end,
''',
    r'''
    # Schema 1.10 (library 1.11.0): 1_customer is exactly the seven implementation attributes. The six seed-data
    # keys and the two supplier-messaging keys left at 1.9; applicationName, outputDriveFolderId and
    # lastDayForSubmission left at 1.10; customerLogoUrl arrived. Seeding is configured in the portal now
    # (validate_seed takes index_key from its caller), so none of the retired keys has a reader on this side.
    #
    # After 1.10 (Nov 2026): supplierManagerEmail (eighth row, invited to the portal's Supplier managers group by
    # PRV-01 / API-04) and the uploaded logo. The logo row now holds the Drive link lib_sdc wrote after the analyst
    # uploaded the image; the library sends it as customerLogoDriveUrl and, when it has it, customerLogoFileId.
    # customerLogoUrl is the legacy public link and stays mapped until the Workato side stops reading it.
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

    # Grid-fallback only: 1_customer label (downcased) -> registry key.
    # Mirrors Labels in 003_Schema.js. Feeds customer_key_map above. Two labels exist for the logo row: the legacy
    # "Customer logo public link" and the "Customer logo" row that holds the uploaded file's Drive link.
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


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    path = args[0]

    with io.open(path, "r", encoding="utf-8") as fh:
        original = fh.read()
    text = normalize(original)

    problems = []
    for name, old, new in EDITS:
        old_n, new_n = normalize(old), normalize(new)
        n = text.count(old_n)
        if n == 1:
            text = text.replace(old_n, new_n)
            print(f"ok       {name}")
        elif n == 0:
            problems.append(f"MISSING  {name}: anchor text not found")
        else:
            problems.append(f"AMBIGUOUS {name}: anchor text found {n} times")

    if problems:
        print("\n".join(problems))
        print("\nNothing written. The connector text differs from the 2026-11-11 copy at the places above; "
              "apply those edits by hand from the EDITS in this script.")
        sys.exit(1)

    if check_only:
        print("\n--check: all anchors match; run again without --check to apply.")
        return

    shutil.copyfile(path, path + ".bak")
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text + ("\n" if not text.endswith("\n") else ""))
    print(f"\nwritten {path} (backup at {path}.bak)")


if __name__ == "__main__":
    main()
