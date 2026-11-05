# SDC Phase 2 — Scope Items: Solution Detail and Scope

Companion to *sdc-phase2-scope-items.md*. Each item expands the proposed solution a little and draws its boundary: what is in scope, what is out, and the assumptions or dependencies the estimate rests on. Written for a stakeholder audience; the detailed design follows gate approval.

---

## 1. SOW implementation support

### Proposed solution — detail

Today each supplier has one request that moves through a fixed sequence of steps: invited, submitted, validated, reviewed, approved. SOW engagements don't fit that shape because the supplier's input arrives as several documents over the life of a project, and those documents are often tied to milestones or time periods rather than to a single "send us your roster" moment.

The change is to let one supplier hold several tasks at the same time, each with its own template and its own status. The analyst decides which templates to release and when; a supplier might receive a project set-up template at kickoff, a milestone template when the first milestone is due, and a timesheet-style template monthly. Each task is validated and reviewed on its own, so one late or failed document doesn't block the others.

The platform's existing building blocks — templates generated from configuration, validation rules, the review queue, reminders — are reused as they are. What changes is the layer that tracks "where is this supplier up to," which becomes "where is each of this supplier's tasks up to."

### Scope

**In scope**
- More than one template per supplier, released in phases by the analyst.
- Several concurrent tasks per supplier, each with its own lifecycle, visible to supplier and analyst.
- Applying the existing validation rules to SOW templates.
- One pilot SOW engagement end to end.

**Out of scope**
- New SOW-specific validation rules (rates against milestones, dates against project windows) — pending discovery; see item 9 note.
- Any change to how MSP implementations run; they must behave exactly as today.
- Milestone or project scheduling logic (the platform collects data about milestones; it does not plan them).

**Assumptions and dependencies**
- The set of SOW document types is finite and can be agreed up front with the implementation team.
- The task-level change does not require re-doing how a project is set up at the top level.
- This item is the foundation for items 2, 3 and 4, which all require "a second task for an existing supplier."

---

## 2. In-flight changes to data

### Proposed solution — detail

Once a submission is approved today, it is effectively final; a correction means the analyst stepping in by hand. The proposal adds a small, controlled path for the supplier to request a change.

From their portal, the supplier picks an approved submission, says what needs to change and why, and sends the request. The analyst sees it in their queue alongside the original submission and either declines (with a note back to the supplier) or accepts. Accepting issues the supplier a correction task — a copy of their approved data, ready to edit. The corrected submission goes through the same validation and review as any other submission; nothing bypasses the usual checks.

The original approved version is never overwritten. The history shows the first approval, the change request, the reason, and the corrected approval, so an auditor or a later analyst can see exactly what changed and when.

### Scope

**In scope**
- Supplier-initiated change request on an approved submission, with a reason.
- Analyst accept/decline with a note to the supplier.
- A correction task pre-filled from the approved data, routed through standard validation and review.
- Full version history per supplier submission.

**Out of scope**
- Analyst-initiated edits to a supplier's approved data (the analyst asks the supplier to correct, rather than editing on their behalf).
- Partial or field-level approvals; a correction is approved or declined as a whole.
- Changes to data already exported to the downstream VMS — re-export is handled by the existing export process, not by this item.

**Assumptions and dependencies**
- Depends on the multi-task model in item 1.
- The submission-attempt limit applies to the correction task as it does to first submissions.

---

## 3. Unknown field routing

### Proposed solution — detail

A required field the supplier can't answer currently leaves them two bad options: leave it blank and fail validation, or type something plausible and pass. Both create work later. The proposal gives them a third option that is honest and visible.

On the submission form or upload, the supplier can mark a field (or the whole submission) as "needs analyst input" and add a short note — for example, "we don't hold cost centre codes; please advise." Validation then treats those fields as deferred rather than failed, and the submission goes directly to the analyst instead of bouncing back to the supplier.

In the review queue, flagged items are shown separately from genuine errors, with the supplier's note. The analyst can fill in the value from their own knowledge, accept that the field is legitimately empty for this supplier, or return it to the supplier with guidance. Only once every flag is resolved can the submission be approved.

### Scope

**In scope**
- Supplier-side flagging of a submission, with a note, on both the form and upload channels.
- Routing flagged submissions to analyst review ahead of the usual pass/fail outcome.
- Analyst resolution options: supply a value, accept the gap, return to supplier.
- Flagged items shown distinctly from validation errors in the review queue.

**Out of scope**
- Suggesting likely values to the supplier (no lookups or AI assistance here).
- Changing which fields are required; that remains a configuration decision per implementation.
- Flagging on optional fields (a blank optional field is already acceptable).

**Assumptions and dependencies**
- Submission-level flagging is already in the plan of record; this item adds the field-level view and the analyst resolution step.
- Returning a flagged submission to the supplier relies on the multi-task model in item 1.

---

## 4. Template modifications

### Proposed solution — detail

Templates can be re-versioned today, but a mid-implementation change still means the analyst managing the fallout by hand: who has the old template, who needs the new one, who has already submitted. The proposal makes the platform handle that fan-out.

When the analyst publishes a change, the platform creates a new template version and compares it with the previous one to work out what changed — fields added, removed, renamed, or with new allowed values. Every supplier's task is tied to a specific version, so nothing already submitted is silently altered.

Suppliers who haven't submitted yet are moved to the new version; their task simply reflects the updated template the next time they open it. Suppliers who have already submitted receive a short follow-up task that asks only about the changed fields, with their previous answers carried forward where the field still exists. The analyst can see, for every submission, which version it was validated against.

### Scope

**In scope**
- Publishing a template change as a new version in one analyst action.
- Automatic comparison of old and new versions to identify what changed.
- Moving unsubmitted tasks to the new version.
- Issuing a changes-only follow-up task to suppliers who already submitted, with prior answers carried forward.
- Version visibility on every submission.

**Out of scope**
- Changing a template for a single supplier; versions apply to the whole implementation.
- Rolling back to a previous version (a correction is published as a further new version).
- Re-validating already-approved submissions against new rules; approval stands unless the supplier is asked for a follow-up.

**Assumptions and dependencies**
- Depends on the multi-task model in item 1 for the follow-up task.
- Changes that remove a field the supplier has already filled need a decision rule (keep the data for history, drop it from export); that rule is settled in design.

---

## 5. Error review process improvements

### Proposed solution — detail

A failed submission today produces a summary report: counts, worst rows, a list of errors by row and column reference. To understand an error in context, the analyst often re-opens the supplier's file and finds the row by hand, or reformats the error list to line up with the data.

The proposal is to make the supplier's own file the review surface. For each failed submission, the platform produces an annotated copy of what the supplier sent: same sheet, same columns, same row order, with failing cells highlighted and the reason attached as a cell note. The analyst opens one file and reads the errors where they sit.

Form-channel submissions, which don't start life as a spreadsheet, are rendered into the same layout so both channels review identically. The existing summary report stays for counts, trends, and the per-row summary stakeholders asked for; the annotated copy becomes the working tool.

### Scope

**In scope**
- An annotated copy of the supplier's upload for every failed submission, with errors on the cell they relate to.
- The same annotated view for form submissions.
- Links to the annotated copy from the analyst's review page alongside the existing report.

**Out of scope**
- Editing data in the annotated copy (it is a review view, not a correction tool; corrections still come from the supplier).
- Sending the annotated copy to the supplier automatically — a possible later addition, but not part of this item.
- Changing the validation rules or their messages.

**Assumptions and dependencies**
- Depends on the ability to render form submissions as a filled spreadsheet, which is already in progress.
- The supplier's original file is retained for every submission attempt, as it is today.

---

## 6. Batch add suppliers

### Proposed solution — detail

Suppliers are set up at kickoff from the project configuration. Adding suppliers later means either editing that configuration and re-running set-up, or adding them one at a time through the analyst page. Neither suits the common case of "the client just sent us thirty more."

The proposal is a single upload: the analyst downloads a short layout (supplier name, contact name, email, and a few optional fields), fills it, and uploads it. The platform checks every row — required details present, email format valid, no duplicates against suppliers already in the project — and shows the analyst a preview: these rows will be added, these will be rejected, and why. Nothing is committed until the analyst confirms.

On confirmation, accepted suppliers are created, given their task, and invited in one run, exactly as if they had been in the project from the start. Rejected rows come back as a downloadable list with the reason against each, so the analyst can fix and re-upload just those.

### Scope

**In scope**
- A provided upload layout for suppliers and their contacts.
- Row-level checks and a preview before commit.
- Creation, task assignment, and invitation in one run.
- A rejected-rows list with reasons.

**Out of scope**
- Updating or removing existing suppliers by upload (this item adds; existing records are managed as today).
- Importing suppliers from an external system directly; the source is a file the analyst provides.
- Bulk changes to supplier contacts on existing suppliers.

**Assumptions and dependencies**
- Builds on the existing "add suppliers found in seed data" offer; the upload path and the seed path should share the same checks.
- Batch-added suppliers use the current live template version.

---

## 7. Master data collection

### Proposed solution — detail

Every implementation depends on reference lists the client owns: valid job titles, locations, cost centres, business units, and similar. Today analysts gather these informally and transcribe them into the configuration, which is slow and a common source of mismatch between what the client meant and what suppliers are offered.

The proposal is a one-time, structured request to the client at the start of an implementation. The platform works out, from the implementation's configuration, which reference lists are needed, and generates a request pack: one simple template per list, with instructions. The client fills them and returns them through a portal page or by upload.

Returned lists are checked for completeness and duplicates and shown to the analyst for a quick confirmation, then loaded straight into the configuration. Supplier templates and forms then offer the client's values in their dropdowns, and the "not an allowed value" check uses the client's list rather than the analyst's transcription of it.

Suppliers themselves are included only as they relate to this project — names and contacts to invite — not as a general supplier master.

### Scope

**In scope**
- Generating a reference-data request pack from the implementation's configuration.
- A client-facing way to return the lists (portal page or upload).
- Completeness and duplicate checks, analyst confirmation, and direct load into configuration.
- Analyst visibility of what has been returned and what is outstanding.

**Out of scope**
- A general supplier master or vendor-master integration.
- Ongoing synchronisation with the client's systems; this is a one-time collection per implementation (changes afterwards go through item 4).
- Validating the *content* of client lists beyond structure and duplicates (the client owns what a valid job title is).

**Assumptions and dependencies**
- The needed reference lists can be derived from the configuration's dropdown fields; lists not represented in configuration are added by the analyst as today.
- Item 8 validates seed data against the lists this item produces.

---

## 8. Validate seed data against the configuration

### Proposed solution — detail

Seed data — the client's existing records, used to pre-fill supplier templates so suppliers confirm rather than re-key — has no defined shape today. Analysts work from past examples, and problems surface only when the pre-filled templates look wrong.

The proposal has two halves. Before upload, the analyst page shows the expected layout for this implementation, generated from its own configuration: which columns are required, what format each takes, and which allowed values apply. On upload, the file is checked against that same configuration: structure, formats, values against the configured lists, and supplier names against the project roster.

The analyst sees a report before anything is committed: rows that will load cleanly, rows that won't and why, and any suppliers present in the data but absent from the roster, with a one-step offer to add them. Templates are only pre-filled from data that passed.

Much of the checking already exists in the platform; this item makes it visible and usable from the analyst's page.

### Scope

**In scope**
- Showing the expected seed layout for an implementation, derived from configuration.
- Validating uploaded seed data: structure, formats, allowed values, roster match.
- A pass/fail report with row-level reasons before commit.
- The "add missing suppliers from seed" offer whenever unknown suppliers are found.

**Out of scope**
- Cleaning or transforming seed data (the analyst fixes the source file; the platform reports).
- Accepting seed data in formats other than the expected layout.
- Pre-filling templates from partially valid seed data.

**Assumptions and dependencies**
- The seed layout can be fully expressed from the configuration plus the client's reference lists (item 7).
- Seed data is an analyst-supplied file, not a client-facing collection.

---

## 9. Note on rate validation

Rate validation is on the register but is not framed here, because its shape is still open: the team's current preference is a supplier-facing rate calculator rather than a validation rule, and it may turn out to be part of the SOW story (rates against milestones) rather than a standalone item. The recommendation is one timeboxed discovery covering both questions, with scope confirmed at the following checkpoint, rather than committing to a definition now.
