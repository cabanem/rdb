# SDC Phase 2 — Scope Items

Each item below is framed for a non-technical audience in three parts: the request as understood, the proposed solution, and what done looks like for the completed item. Approval at this gate means proceeding to detailed solution design; it does not commit build effort.

---

## 1. SOW implementation support

**Request**
Support SOW (statement-of-work) implementations alongside the MSP implementations the platform handles today. SOW engagements are different in shape: a supplier's input arrives as several documents over time, tied to project milestones and time-based work, rather than as one roster-style upload at the start.

**Proposed solution**
- Allow more than one template per supplier, released in phases as the engagement progresses.
- Let each supplier carry several open tasks at once, each with its own status, instead of a single request that moves through one fixed sequence of steps.
- Reuse the existing validation rules on the new templates; any SOW-specific rules (e.g. rates against milestones) are confirmed in discovery, not assumed.

**Done when**
- The SOW document set and task types are agreed with the implementation team.
- A design for the multi-task model exists, reviewed and approved, that MSP implementations can run on unchanged.
- One pilot SOW engagement completes an end-to-end collection cycle on the platform.

---

## 2. In-flight changes to data

**Request**
A supplier can ask to correct a submission that has already been approved, instead of the data being locked once it passes review.

**Proposed solution**
- A supplier can open a change request on an approved submission, stating what needs to change and why.
- The analyst accepts or declines; if accepted, the supplier gets a new task to submit the correction, which goes through the normal validation and review.
- The original approved submission is kept as history, so what was approved, and when, is always traceable.

**Done when**
- A supplier can raise a change request from their own portal without contacting the analyst by email.
- The analyst sees the request, the reason, and the original submission side by side, and can approve or decline in one step.
- Every correction is validated and reviewed the same way as a first submission, and the approval history for that supplier is complete and visible.

---

## 3. Unknown field routing

**Request**
A supplier who cannot complete a required field can flag it for the analyst rather than entering placeholder data to get past validation.

**Proposed solution**
- The supplier marks the submission (or specific fields) as "needs analyst input" with a short note.
- Validation treats flagged fields as deferred rather than failed, and the submission routes straight to analyst review instead of bouncing back to the supplier.
- The analyst resolves each flag: supplies the value, accepts the gap, or returns it to the supplier with guidance.

**Done when**
- A supplier can submit with flagged fields and is never required to invent a value.
- Flagged items appear in the analyst's review queue, clearly separated from validation errors.
- No approved submission contains placeholder values that were entered to satisfy validation.

---

## 4. Template modifications

**Request**
An analyst can change a template partway through an implementation. Suppliers who haven't submitted see the new version; suppliers who have submitted receive a new task showing what changed.

**Proposed solution**
- Template changes are published as a new version; each supplier's work is tied to a specific version, so nothing already submitted is altered retroactively.
- Suppliers with open, unsubmitted tasks are moved to the new version automatically.
- Suppliers who have already submitted receive a follow-up task limited to the changes (new, removed, or altered fields), with their previous answers carried forward.

**Done when**
- The analyst publishes a template change in one action; no manual re-invitation or re-setup per supplier.
- Each supplier sees the correct version for their situation, and the analyst can see which version every submission was validated against.
- A supplier who already submitted is asked only for what changed, not for a full resubmission.

---

## 5. Error review process improvements

**Request**
An analyst can review validation failures in the same shape the supplier submitted them, so errors are read in context without reformatting.

**Proposed solution**
- For every failed submission, the system produces an annotated copy of the supplier's own file, with failing cells highlighted and the reason attached to each.
- The same view is available for form submissions, rendered into the same spreadsheet layout.
- The existing summary report remains for counts and trends; the annotated copy becomes the primary review tool.

**Done when**
- For any failed submission, the analyst can open one file that shows errors on the exact row and column where the supplier entered them.
- The analyst no longer rebuilds or reformats supplier data to understand a failure.
- Tester feedback confirms time-to-diagnose per failed submission has dropped against the current process.

---

## 6. Batch add suppliers

**Request**
An analyst can add many suppliers and their contacts at once, during an implementation, rather than one at a time or by reconfiguring the project.

**Proposed solution**
- The analyst uploads a list of suppliers and contacts in a provided layout.
- The system checks the list (required details present, no duplicates against suppliers already in the project) and reports what will be added before anything is committed.
- Accepted suppliers are created, assigned tasks, and invited in one run; rejected rows are returned with the reason.

**Done when**
- The analyst can add a batch of suppliers from a list in a single action, at any point in the implementation.
- Every row is either added and invited, or returned with a clear reason — no silent partial loads.
- Suppliers added in a batch are indistinguishable from suppliers set up at kickoff.

---

## 7. Master data collection

**Request**
Collect the reference data an implementation depends on — dropdown values, job titles, locations, cost centres and similar — from the client once, up front, rather than analysts chasing it piecemeal and typing it into the configuration by hand.

**Proposed solution**
- The client receives a structured request listing exactly which reference lists are needed for their implementation, with a template per list.
- The client's responses are checked for completeness and duplicates, then loaded directly into the template configuration, so supplier dropdowns are populated from what the client provided.
- Suppliers are collected only as they relate to this project (name and contacts), not as a full supplier master — that remains out of scope.

**Done when**
- A client can be sent one request that covers all reference data for their implementation, and the analyst can see what has been returned and what is outstanding.
- Returned lists load into the configuration without the analyst re-keying values.
- Suppliers see client-provided values in their dropdowns, and "value not in the client's list" validation failures reflect the client's data, not the analyst's transcription.

---

## 8. Validate seed data against the configuration

**Request**
When an analyst uploads existing (incumbent) data to pre-fill supplier templates, the system checks it against the project's configuration before it is used, and tells the analyst what is expected rather than leaving them to guess the layout.

**Proposed solution**
- Before upload, the analyst is shown the expected seed layout, generated from the project's own configuration (required columns, formats, and allowed values).
- On upload, the file is checked against that configuration: structure, formats, values against the configured lists, and supplier names against the project roster.
- The analyst gets a report of what will load cleanly, what won't, and why — plus an offer to add any suppliers present in the data but missing from the roster — before anything is committed.

**Done when**
- The analyst can see the expected seed layout for a project without asking the developer or inspecting a past example.
- Every seed upload produces a pass/fail report with row-level reasons before it is used to pre-fill templates.
- No supplier template is pre-filled from seed data that failed validation, and suppliers found only in the seed data can be added to the roster from the report in one step.

---

## 9. Analyst user interface improvements

**Request**
Analysts work today through a configuration spreadsheet and a set of portal pages that are inconsistent and hard to read. They want to set up and run an implementation from a clear set of pages, without needing to understand how the spreadsheet is wired.

**Proposed solution**
- Move implementation set-up (client details, kickoff, supplier roster) from the configuration spreadsheet into a guided web page, starting from a reviewed field pack for the client's VMS and record type rather than a blank sheet.
- Rebuild the analyst portal pages on one consistent pattern: every action gives a clear result message, next step, and links, in the same place every time.
- Keep the configuration spreadsheet underneath as the record for now; the pages become the way analysts work with it.

**Done when**
- An analyst can set up a new implementation end to end from the web page, choosing a field pack and adjusting it, without opening the configuration spreadsheet.
- Every analyst portal page uses the same feedback pattern, and tester feedback confirms analysts can tell what happened and what to do next after each action.
- No implementation set up through the page needs developer intervention to correct configuration.

---

## 10. Analyst training on the phase 1 system

**Request**
Analysts need to understand what the platform does today and how to run an implementation on it confidently. Current knowledge lives with the developer and in notes written for the developer, and analysts either under-configure or over-configure as a result.

**Proposed solution**
- Produce a short, task-based analyst guide: set up an implementation, invite suppliers, review a submission, handle a failure, close out — written in the analyst's terms, not the system's.
- Run hands-on sessions on a test implementation, where each analyst completes a full cycle with realistic data.
- Capture the questions and mistakes from those sessions and feed them back into the guide and into item 9's page design.

**Done when**
- Every current analyst has completed one full implementation cycle on the test environment.
- The analyst guide exists, is owned by the team, and a new analyst can run a standard implementation from it with no developer involvement.
- The questions raised in training are logged and each has either an answer in the guide or an item on the backlog.

---

## Author's notes (remove before circulating)

- **Items 2, 3 and 4 depend on the task-model change** in item 1 (several tasks per supplier, each with its own lifecycle). A change request, a follow-up task after a template change, and a flagged-and-returned submission are all "a second task on an existing supplier." Sequence that foundation first; the one-pager can say so in one line.
- **Item 3 is partly designed.** The per-submission flag and comments fields, and routing a flagged submission to the analyst ahead of the submission limit, are already in the plan of record. The new part is field-level flagging and the analyst's resolution step.
- **Item 5 gets cheaper** if the form-channel-to-filled-spreadsheet rebuild lands, since that is what makes "same shape" hold for both submission channels. List it as a dependency rather than re-scoping it here.
- **Items 9 and 10 are the adoption pair.** Item 10 (training) will surface exactly the confusions item 9 is meant to remove; run them close together and let the training log drive the page design. Decide the order deliberately — training on the old set-up then re-training on the new page is wasteful if item 9 is close.
- **Item 8 is further along than it reads.** Seed validation exists in the connector today (roster checks, unknown supplier names, empty-roster handling); the gap is the analyst-facing half. Frame it as "finish and expose," not "build."
- **Items 7 and 8 share a boundary worth stating once:** master data is what the *client* supplies to define the allowed lists; seed data is what the *analyst* supplies to pre-fill supplier answers. Item 7 defines the values; item 8 is checked against them.
- **Open question from the SOW discussion:** whether "data validation for SOW" means reusing existing rules or new SOW-specific rules (rates against milestones, dates against project windows). Rate validation may be part of the SOW story — keep them as linked items with one shared discovery rather than merging prematurely.
