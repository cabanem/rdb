# ADR 0001 — Customer logo hosting

Nov 15, 2026 · @Emily Cabaniss

## Executive summary

We will show each client's logo in the supplier portal and in our emails by keeping the logo file inside the client's own Workato workspace and refreshing its link automatically once a day. Analysts upload the logo in the configuration workbook, which already works; nothing else changes for them, and no portal page or email template is rewired.

**The situation.** The portal and the emails take the client logo from one setting per engagement. Until now an analyst had to find a publicly reachable web address for the image and paste it in. In practice that setting was never populated by our own pipeline, so logos rendered inconsistently or not at all. The workbook now accepts an uploaded image file instead, which leaves one question: where the image is served from.

**The complication.** The usual answer, a public cloud bucket, is not available to us without exceptions to company policy on public storage. Every alternative inside Workato trades something: some require every portal page to be rewired, some slow page loads and add cost on every view, one would make the central routing workspace part of every client's daily operation, and one cannot produce a web address at all.

**The decision.** Store the uploaded image in the client's Workato file storage, mint a short-lived link to it, and refresh that link daily into the setting the portal already reads — using a single-purpose credential that can write that setting and nothing else. A default company image shows until a client logo exists.

**What it costs.** About five automation tasks per client per day, one small connector, and one narrowly scoped credential per workspace, created at setup. The link lasts seven days, so the daily refresh is load-bearing; a failed refresh raises an alert and the previous link keeps working until it expires.

|  |  |
| --- | --- |
| Status | Proposed; becomes Accepted when the three checks in Verification pass |
| Decision owner | Emily Cabaniss, Automation Center of Excellence |
| Scope | Customer logo only. Supplier submissions, validation reports and other files keep their existing access-controlled links |
| Build plan | [Handoff: customer logo link refresh via project properties](https://claude.ai/artifact/1DjyQwacwh3bTCmnu4DDJS) |

## Decision drivers

Five requirements had to be met outright; an option that misses one is out regardless of its other merits. Six preferences then rank what remains.

**Must (pass or fail)**

1. The image renders in a portal page image component and in an outbound email. Verified for Workato file-storage links on 2026-11-11.
2. No public exposure beyond what company sharing policy allows: no public storage bucket, no "anyone with the link" sharing.
3. Any credential placed in a client workspace can do only the task it is there for.
4. Once a client workspace is set up, it runs without depending on the central routing workspace.
5. One master copy of the solution serves every client; no per-client edits.

**Want (ranked, most important first)**

1. No changes to portal pages, their loading recipes, or email templates.
2. No automation call on every page view (latency, and a task charged per view).
3. Low running cost in automation tasks.
4. A permanent link that never needs refreshing.
5. Little new infrastructure: connectors, buckets, credentials.
6. A problem can be diagnosed inside one workspace.

The musts came from policy and from how the estate is built; the wants are the trade-offs the team weighed in discussion between 11 and 15 November 2026.

## Options considered

Each option is stated as its proposer would state it, then the requirement it fails or the trade-off it carries.

**A. Analyst supplies a public web address (the current design).** No infrastructure at all: the analyst finds the logo on the client's website or another public page and pastes the address. In practice: our own pipeline never carried that address through, client websites change their image addresses, and when a client has no public image we would have to host one ourselves, which brings us to B. Fails must 1 as built and must 2 whenever we host.

**B. Public cloud storage bucket.** The textbook answer for public images: a dedicated bucket, a permanent address per logo, caches and email clients happy forever, and we already own a connector that can move a file from Drive into a bucket. Fails must 2: company policy prevents public access on cloud storage and restricts sharing to company domains; both would need standing exceptions on a dedicated project, plus a service account with write rights to the bucket. Also the most new infrastructure of any option.

**C. Store the image bytes on each supplier request record.** Keeps everything inside Workato, needs no hosting and no credential, and a page already reads the request record. Fails must 1: a portal image component and an email template need a web address to fetch, not a stored blob, so the bytes would still have to be served from somewhere. It would also copy one engagement-level image onto every request row of the busiest table in the estate.

**D. Mint a link each time a page loads.** The page-loading recipes already run on every view and already read the project record; adding a link mint there keeps the link always fresh with no scheduled job and no extra credential. Passes every must. Trade-offs: an automation call and a charged task on every page view, extra latency on every view, and four pages plus two loading recipes and the email senders to rewire.

**E. The central routing workspace refreshes every client's setting on a schedule.** Pages stay untouched and there is one place to run and watch the job. Fails must 4: the routing workspace, holding a broad administrative token for each client, becomes part of every client's daily operation; a revoked token or a stopped job in one workspace breaks logos everywhere, and nothing in the client's own logs explains why.

**F. Each client workspace refreshes its own setting daily through a single-purpose credential (chosen).** The logo file sits in the client's own file storage; a small recipe mints a seven-day link and writes it into the setting the pages already read; a daily schedule and the provisioning step both call it; the credential can write that project's settings and nothing else. Passes every must. Trade-offs: no permanent link (the daily job is load-bearing), one small connector, and one narrow credential created per workspace at setup.

## Evaluation

Only D and F pass every must. F meets four of the six wants, D two; the two F concedes (a permanent link, minimal new infrastructure) rank fourth and fifth, while the two D concedes (no per-view call, low running cost) rank second and third.

| Option | 1 Renders | 2 No public exposure | 3 Least privilege | 4 Client stands alone | 5 One master copy | Wants met (of 6) |
| --- | --- | --- | --- | --- | --- | --- |
| A. Analyst public address | fail | fail | pass | pass | pass | — |
| B. Public bucket | pass | fail | pass | pass | pass | — |
| C. Bytes on request records | fail | pass | pass | pass | pass | — |
| D. Mint on page load | pass | pass | pass | pass | pass | 2: minimal infrastructure; one workspace |
| E. Router refreshes on schedule | pass | pass | fail | fail | pass | — |
| F. Workspace self-refresh (chosen) | pass | pass | pass | pass | pass | 4: no page edits; no per-view call; low task cost; one workspace |

How the wants fell for the two finalists:

| Want (ranked) | D. Mint on page load | F. Self-refresh |
| --- | --- | --- |
| 1 No page, loading-recipe or email edits | 4 pages, 2 recipes, email senders | none |
| 2 No automation call per page view | one per view | none |
| 3 Low running cost | a task per view | \~5 tasks per client per day |
| 4 Permanent link | no (refresh per view) | no (refresh daily) |
| 5 Minimal new infrastructure | none | one connector, one credential per workspace |
| 6 Diagnosable in one workspace | yes | yes |

## Decision and consequences

We adopt option F. Each client workspace keeps the uploaded logo in its own file storage, mints a seven-day link to it, and refreshes that link daily into the setting the portal pages already read, through a credential that can write that project's settings and nothing else. Provisioning performs the same refresh immediately, so a new or changed logo shows without waiting for the next day.

**What we gain**

- No portal page, loading recipe or email template is touched; the binding check in the documentation set stays at zero.
- Each client workspace is self-contained after setup; the central routing workspace has no part in the daily path.
- The only credential added to a client workspace is scoped to one project, one environment and one endpoint family, and can be revoked in one place.
- No public storage, no policy exceptions, no untrusted-content question (the image never leaves our own origin).

**What we accept**

- The link expires after seven days, so the daily job is load-bearing. A failed refresh raises an event; the previous link keeps working until it expires, which gives at least six days to notice.
- A page left open for more than a week shows a broken logo on its next repaint until reloaded. By design; nobody does this.
- One more custom connector in the golden estate (the third) and one more hand step per workspace at setup (create the narrow credential).
- A default company image must exist at a stable public address we control, for engagements with no logo yet.

**Follow-ups this decision creates**

- The three checks under Verification, before any build.
- The build itself, per the handoff document.
- A line in the estate's documented invariants: a file-storage link is never treated as permanent; the logo setting has exactly one writer after setup.
- The setup runbook gains the credential step.

**We would revisit this decision if**

- The company grants a dedicated public-assets project with the storage-policy exceptions (option B becomes available, and removes the refresh machinery).
- Workato adds permanent file-storage addresses, or a native action to write project settings (removes the connector and the credential).
- The first check fails: a page turns out to read a setting only when republished (option F cannot work; option D is the fallback).

## Technical detail

This section is for the engineers who build and operate it. The executive summary and decision above stand on their own; build steps are in the [handoff document](https://claude.ai/artifact/1DjyQwacwh3bTCmnu4DDJS).

&#91;embedded content: logo link refresh loop · 2 triggers, 1 recipe, 2 stores, 2 readers\]

**Components**

| Component | Role | New or changed |
| --- | --- | --- |
| Config workbook upload (Apps Script, `lib_sdc`) | Analyst uploads the image; a copy lands in the engagement's Drive folder shared with the integration principal; the file ID and Drive link travel on the `/provision` payload | Already landed |
| Functional core connector | Parses the two new logo fields from the config export | Patched, to release |
| PRV-01 Provisioning | Copies the Drive file into the project's file storage (`branding/`, via UTL-13), records the path on the Project record, clears the cached link, calls LNK-03 | Changed |
| LNK-03 Refresh customer logo link | Reads the Project record; mints a new 7-day link through UTL-01 when fewer than 24 hours remain (144 when an email sender asks); writes link and expiry to Project; upserts `IMAGE_PUBLIC_URL_CLIENT`; writes the default image when no logo exists | New recipe function |
| CAL-02 | Daily schedule calling LNK-03 | New scheduled recipe |
| Workato Project Properties connector | One connection (data center, token, project ID); actions: upsert properties with read-back, list by prefix. Cut from the Developer API connector | New custom connector |
| Developer API client `SDC properties writer` | Role: project-properties endpoints only; project scope: the SDC project; environment: the one the recipes run in | New per workspace, created at setup |
| POOL-12 (spin-up) | Writes the default image into `IMAGE_PUBLIC_URL_CLIENT`, the `project_id` property, and fills the connector's connection from a new `RTR_Secrets.properties_api_token` | Changed |
| Portal pages, WFA-001/WFA-017, INV-01, STS-01 | Read the setting or the Project column, as today | Unchanged |

**Platform facts the design relies on**

- `POST /api/properties?project_id=…` upserts project properties: 60 requests per minute, values up to 1,024 characters.
- Developer API clients are scoped by client role, environment and project list; project scope covers properties; role edits apply immediately.
- Project property values are frozen at the start of each job; a new job reads the current value. Pages are expected to read the current value on load (gate 1 confirms).
- UTL-01 mints with `expires_in` = 604,800 seconds and returns `link` and `expires_at`.
- There is no native recipe action for the Developer API, which is why a connector and a token are needed.

**Cost and failure modes**

- Running cost: CAL-02 about five tasks per workspace per day; LNK-03 is called once more per provision.
- Refresh failure (token revoked, file storage error): OBS-01 event `logo_link_refresh_failed`; the property keeps the previous link, valid for up to six more days; the job itself succeeds.
- Daily job stopped for seven days: logo breaks on next page load; EventLog shows the missing refreshes. API-03 `/health` can report the expiry if the pool should see it (open decision).
- A link over 1,024 characters would be refused by the connector before the write (gate 3 rules this out).

**Security**

- The token in a client workspace can write properties of one project in one environment and nothing else; it is never the pool's `dev_api_token`.
- The token lives in the connector's connection (encrypted) and in `RTR_Secrets`; it appears in no job data.
- The image is served from Workato's own origin; no public bucket, no shared origin with other tenants, no SVG concern. Upload is restricted to raster formats on the Apps Script side.

## Verification and sources

The decision moves from Proposed to Accepted when the three checks pass; the rest of the table records what this document rests on and how each item was established.

| Item | How established | Status |
| --- | --- | --- |
| A Workato file-storage link renders in a portal image component | Tested by Emily Cabaniss on a draft page, 2026-11-11 | Verified |
| The logo pipeline as built never worked (API-00 dropped the field; the pool column was never written) | Read from the golden and BASE project exports of 2026-11-09 | Verified |
| Project properties can be upserted by API; 60/min; 1,024-character values | [Workato Developer API: project properties](https://docs.workato.com/en/workato-api/project-properties.md) | Verified |
| API clients are scoped by role, environment and project; project scope covers properties | [Workato Developer API: API clients](https://docs.workato.com/en/workato-api/api-clients.md) | Verified |
| Property values are frozen per job; the next job reads the new value | [Workato: project properties](https://docs.workato.com/features/project-properties) | Verified |
| No native recipe action exists for the Developer API | [Workato community thread](https://systematic.workato.com/t5/workato-pros-discussion-board/workato-connector-developer-api/m-p/10607) | Verified |
| Company policy blocks public cloud storage buckets without exceptions | Stated by Emily Cabaniss, 2026-11-15 | Stated |
| Check 1 — a portal page shows a changed setting on reload, without republishing | Edit the setting by hand, reload a page | Pending |
| Check 2 — the narrow credential can write properties and nothing else | Call the properties endpoint and a recipes endpoint with it | Pending |
| Check 3 — a minted link is under 1,024 characters | Read its length in a test job | Pending |

If check 1 fails, option D (mint on page load) is the fallback and this record is reopened. If check 2 or 3 fails, the design is adjusted (a broader role, or a shortened link) without changing the decision.
