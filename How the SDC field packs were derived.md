# How the SDC field packs were derived

Nov 17, 2026 · @Emily Cabaniss

The two SDC field packs came from different sources: the VNDLY pack from a working client configuration, and the Fieldglass pack from SAP's published upload specification.

A field pack is a ready-made starting configuration for one vendor management system (VMS) and one record type. It pre-fills the list of fields with their formats and rules, so an analyst starts a new implementation from a checked baseline instead of a blank spreadsheet.

Packs exist because analysts were copying a VMS's field list into each configuration by hand. During testing, one configuration turned out to be VNDLY's own layout copied field by field. A pack captures that work once, so it can be reviewed and reused.

| Pack | Covers | Derived from | Status |
| --- | --- | --- | --- |
| `vndly / contractor_work_order` | Workday VNDLY, contractor work orders | A working client configuration (the Sony implementation) | Built and applied successfully in testing |
| `fieldglass / work_order` | SAP Fieldglass, work orders | SAP's public Work Order Upload specification | Draft v0.1.0, delivered 2 Nov 2026 |

A Beeline pack is expected but not started; a sample Beeline specification is still needed.

## How a pack is derived

Every pack follows the same five steps, whatever its source.

1. **Pick the source.** This is either the VMS vendor's published upload specification or a client configuration that already works.
2. **Get the field list into a configuration workbook.** For a vendor specification, the platform reads the vendor's wording and proposes each field's type, format and rules. A working configuration is already in that form.
3. **Check and correct by hand.** A person compares every field with the source, fixes misreadings and removes anything that is not a true field.
4. **Separate standard from client-specific.** Fields every client uses stay in the pack. Fields that depend on how a client has set up their VMS become short yes/no questions, answered when the pack is applied.
5. **Record the source, then test.** The pack carries its source, source date, version and reviewer, plus a notes tab with the decisions made. It is then applied to a fresh workbook and validated.

An analyst who applies a pack picks it from a list, answers its questions and gets a pre-filled workbook to adjust. Using a pack never changes the pack itself.

## The VNDLY pack

The VNDLY pack was lifted from a client configuration that already worked. It was not written from a specification.

- **Source.** The Sony implementation's configuration workbook, in September 2026. Its field list followed VNDLY's own contractor bulk-upload layout, which the analyst had taken directly from VNDLY.
- **What became the pack.** That configuration's fields, rules and dropdown values.
- **What was treated as client-specific.** Fields with "Custom" in their name, because each client defines those for themselves.
- **Result.** A test on 29 October 2026 applied the pack to a workbook and wrote 109 fields, 8 rules and 40 dropdown values.

The field-by-field decisions were not written down when the pack was made. The pack's own notes tab is the best remaining record.

## The Fieldglass pack

The Fieldglass pack was built from SAP's public specification for the Work Order Upload connector. This first version covers the field list only; dropdown values come later.

- **Why that specification.** Fieldglass brings existing contractors in as work orders. The similarly named Worker Upload is for a different record, used for workers who are tracked for compliance only.
- **Reading it in.** The specification's field table was pasted into a blank workbook and read by the platform, which produced 80 rows.
- **Corrections.** Review removed 25 rows that were repeating column groups, not single fields, and one duplicate. That left 54 fields.
- **Required fields.** The automatic reading had marked about 41 rows as required in error. They were reset from SAP's wording: 10 always required, 29 optional, 15 required only in some cases.
- **Client questions.** Those 15 conditional fields are covered by 11 yes/no questions, such as "Does the client use Rate Schedules?"
- **Added defaults.** Sensible limits were added to 12 numeric fields. These are our defaults, not SAP's, and the pack's notes say so.
- **Left for later.** 14 fields take codes that each client defines, and 13 take fixed SAP lists. Both are collected as plain text for now.

## What a pack leaves out

A pack is a starting point. Two things always come from the client, not from the pack.

- **Custom fields.** Each client defines its own in the VMS, so they appear in no public specification. The analyst adds them to the workbook.
- **Client code lists.** Values such as sites, cost centers and rate codes are whatever the client's VMS administrator set up.

## Where to get more information

| For | Go to |
| --- | --- |
| VNDLY upload templates | Workday's Administrator Guide, [Reference: Bulk Uploads](https://doc.workday.com/admin-guide/en-us/vndly-documentation/bulk-actions/reference--bulk-uploads.html). It lists the 11 record types VNDLY can bulk upload and where each sits in the product. Contractors are under More > Company Settings > People > Bulk Upload Contractors in the client's VNDLY tenant. |
| VNDLY field definitions | The Workday VNDLY File Import Specifications, described in [Concept: Bulk Imports](https://doc.workday.com/admin-guide/en-us/vndly-documentation/bulk-updates-and-uploads/concept--bulk-imports.html). It is held on Workday Community, which may need a Workday sign-in. |
| Fieldglass upload specifications | The SAP Fieldglass Connector Library on the SAP Help Portal (help.sap.com), under Work Order Upload. It was public with no sign-in when last checked in September 2026. The direct link is still to be added. |
| A client's custom fields and code lists | The client's VMS administrator. |
| What a pack contains and why | The pack file in the field packs folder on Google Drive. Its details tab (`_pack`) gives the source, version and reviewer. Its notes tab (`_review`) gives the decisions. |
| How packs are built and applied | @Emily Cabaniss, who maintains the packs and the SDC library they run on. |

## Open questions

These points could not be confirmed from the working records and need an answer from the maintainer.

- [ ] **Fieldglass release.** Has the draft been finished and released to analysts? On 2 November it still lacked field lengths, a source date and a reviewer. Some descriptions were written for buyers, not suppliers, and three example values were garbled.
- [ ] **Reading fix.** Has the error that over-marked required fields been fixed before the next pack is built?
- [ ] **VNDLY record.** Should the field-by-field decisions be reconstructed from the pack's notes tab?
- [ ] **Review rule.** Who reviews a pack, what do they check, and when does its version number change?
- [ ] **Links.** Add direct links to SAP's Work Order Upload page and to the field packs folder.
- [ ] **Beeline.** Who can supply a sample Beeline specification?
