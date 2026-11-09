# SDC router — analyst invitation on claim · pending-connections badge · 2026-11-09

Cut against `app_sdc-router-7` (2026-11-09) and `BASE_20261108_2323`.

## 1. Decisions

**The invitation happens at claim, on the router.** Claim is the first moment both facts exist — the workspace
key (chosen by POOL-API-05) and the analyst (on the workbook since creation: the form's `analystEmail`, mirrored
into the app's `workbooks` ledger). Prepare/register don't know the analyst; the PRV chain runs inside the client
workspace, which holds no Developer API token for itself; the router holds `RTR_Secrets.dev_api_token`. So:
web app or menu claim → `POST /workspaces/claim` carries `analyst_email` → POOL-API-05 binds, then calls a new
recipe function POOL-16 that invites through a new connector action → the claim response reports
`invite: {attempted, status, message}` → the app logs it and tells the user. A failed invitation never fails the
claim.

**One owner of "how to invite".** POOL-16 is a recipe function rather than inline steps in POOL-API-05, so a
re-invite endpoint later is three steps, and the claim recipe grows by one call.

**The action is idempotent by email.** It lists collaborators filtered by email first and returns
`already_member` (with roles held) when found; otherwise `POST /member_invitations` for one environment. Role
comes from a project property `COLLABORATOR_ROLE` (default `Analyst`, a Workato system role). Environment:
`dev` for an rlcm client workspace, the pool row's `target_environment` lowercased for a projects-mode row.

**Pending connections become a badge.** `RTR_Pool.pending_connections` (JSON array of connection summaries) is
shown as "⚡ n pending" with the name + application list in a tooltip on hover or keyboard focus, in the pool table
and on the pool cards; the Status panel renders it as a list. The tooltip is one floating element placed with JS,
because `.tablewrap` scrolls horizontally and clips anything positioned inside it. With the JSON column gone and
slightly tighter cells the pool table fits the frame at 1280 px with every button visible (it overflowed by ~86 px
before, which is the "expands beyond the visible area" you saw).

## 2. Files

| Path | What |
|---|---|
| `connector/invite_collaborator.rb` | the action, insertable after `clean_project` |
| `connector/pick_lists.rb` | `collaborator_environment_types`, `collaborator_role_types` |
| `connector/workato_developer_api.custom_adapter.rb` | cumulative: your 2026-11-08 connector + both blocks, CRLF |
| `workato/RECIPES.md` | editor steps: POOL-16 (new), POOL-API-05 (+trigger fields, +call, +`invite` in 200), POOL-API-04 (+`link_to_workspace`), property, token scope, tests |
| `lib_sdc/013_Registry.patch.md` | `Registry.claim` forwards `analystEmail`/`analystName` |
| `app_sdc-router/Code.js` | menu claim reads 1_customer analyst email, passes it, shows the outcome |
| `app_sdc-router/030_Registry.js` | web-app claim: ledger → 1_customer analyst email, `analystEmail_` / `inviteOutcome_`, returns `invite`; `impl_` maps `link_to_workspace` → `workspace_url` |
| `app_sdc-router/Index.html` | invitation line after linking; pending badge + tooltip (table, cards, Status panel); table fits |

Unchanged: 010_CustomerFields, 020_Workbook, 040_WebApp, 050_Health, 060_SelfCheck, appsscript.json.

## 3. Order of application

1. Connector blocks → release. Project property `COLLABORATOR_ROLE`. Check `dev_api_token` scope (RECIPES §0).
2. POOL-16, then POOL-API-05, then POOL-API-04 (RECIPES §1–3).
3. lib_sdc `Registry.claim` patch (HEAD is enough; the router app is in developmentMode).
4. Replace the three app files; redeploy the web app.
5. Tests in RECIPES.md. The GAS side degrades gracefully in every partial state: a router without the new fields
   → "skipped (claim endpoint predates it)"; a library without the patch → the router simply never sees an email →
   "skipped".

## 4. Things I noticed on the way (not changed)

- POOL-13 steps 6/7 and 13/14 are pairs doing the same call, one with the EU data center hardcoded and the other
  with the variable — looks like an edit in progress; the hardcoded ones also appear in POOL-01 (40, 47).
- `workspace_url` was read by the page but never set anywhere; §3 of RECIPES closes that.
- A claim from the workbook menu before the analyst has filled 1_customer gives `skipped`; the re-invite endpoint
  (RECIPES, "Later") is the clean answer when that starts happening.
