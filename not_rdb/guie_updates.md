The guide predates today's schema work, so it's accurate about the dashboard and wrong about the review sheet, which is the section reviewers actually need. Here's what to change, by section, with wording in the guide's voice where it helps. (I can only advise — the source `guide.md` and `build.sh` aren't in the archive, just the built page.)

## Reviewing a contract — rewrite the middle

**Wrong now:** "The Approved column starts as a copy of Extracted." Since the schema cache, the Approved column is typed from Salesforce's field definitions, and some cells arrive blank and highlighted. Suggested replacement for that paragraph and the one after it:

> Below that is a grid with three columns: **Field**, **Extracted** (what Gemini read, word for word) and **Approved** (what will be sent). Approved is filled in for you where Gemini's reading matched what Salesforce accepts, and typed the way Salesforce expects: pick-lists have a dropdown, yes/no fields are checkboxes, dates have a calendar (double-click the cell). Leave Extracted alone — it stays with the record so the correction is visible later.
>
> A **yellow cell** means Gemini's reading didn't fit and you need to choose. Hover the cell for a note saying why — usually "not an option" with the list to choose from. A pick-list that allows several values shows the list in its dropdown, but to pick more than one, type them separated by semicolons: `Canada; France`. A cell you leave blank is simply not sent, and the Salesforce field is left as it was.
>
> When the values are right, tick **Approved?** at the top. Nothing happens the instant you tick it; the Approvals job checks every Approved value against Salesforce's rules on its next run, and if any cell is wrong the sheet stays in the queue with **Status: Error** and a Last error that begins "Not sent — fix the Approved column" and names every cell that needs attention, so you can fix them in one pass. If everything checks, the values are sent to Salesforce and the sheet leaves the queue.

Two smaller additions in this section: a dependent pick-list can be rejected with "requires *X* to be set first" — set the controlling field, then the dependent one; and the Cancel paragraph could name where the sheet goes ("to the Cancelled folder; moving it back to Pending by hand puts it back in the queue").

## Changing the settings — two additions

1. **Fields to extract** now supports an alias: `Label => Salesforce label`. The left side is what Gemini and the reviewer see; the right side is the Salesforce field it maps to. A line needs the alias when the friendly name differs from the Salesforce field label. Suggested help: *"If the name you want on the sheet isn't the Salesforce field's name, write `Your label => Salesforce label`. The Salesforce field schema panel below tells you which lines don't match."*
2. **Salesforce field schema** is a new panel at the bottom of the drawer. It shows when the field definitions were last fetched, how many fields, and any Fields-to-extract lines that don't match a Salesforce field — with a **Refresh now** button (editors only). It refreshes itself every morning. Worth saying plainly: *"Until this has been refreshed at least once, review sheets have no dropdowns and nothing is checked before sending."*

Also: the locked list now includes the schema endpoint; "the Workato endpoints" still covers it.

## When something looks wrong — three new entries

- **A yellow cell on the review sheet** — covered above; one line pointing back.
- **Last error starts "Not sent — fix the Approved column"** — nothing reached Salesforce; every named cell must be fixed, then it retries on the next run.
- **Settings says "N labels not in Salesforce"** — those fields will still be extracted and shown, but have no dropdown and are sent as plain text; add `=> Salesforce label` to each line it names.

## Small accuracy fixes

- **Tile 4, "Errors today"**: it counts error *events* (a failed extraction, a failed push, a failed run), not runs.
- **Errors list (8)**: "the same error repeating is worth reporting" — a push that fails the same way every run is logged once and then suppressed; it keeps showing in the queue row and on the sheet. Reword to: *"A contract that stays on Error shows the reason in the queue; the Errors list shows each distinct failure once."*
- **Pills (1)** also show **Never run** and **Unknown** (the page couldn't read the queue); "Stale" is after three missed polls, about 15 minutes.
- **Header**: there's now a **Guide** button between Refresh and Settings when the guide URL is configured. If the numbered screenshot predates it, callouts 2–3 may sit on the wrong buttons.

## Screenshots to reshoot or add

The dashboard header (Guide button), the Settings drawer (new schema panel; the Model screenshot's locked items are fine), and — the real gap — a review sheet showing a dropdown, a checkbox, a date cell and a yellow cell. That one image carries most of the new section.
