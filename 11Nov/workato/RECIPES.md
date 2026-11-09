# Router recipes — invite the analyst on claim

Three edits in BASE, in this order. Column ids below are from the 2026-11-08 export so you can match pills by
name in the editor; nothing is a hard reference.

## 0. Prerequisites

1. **Connector.** Paste `invite_collaborator` into `actions:` (after `clean_project`) and the two pick lists into
   `pick_lists:` (after `target_environment_types` — add the comma after its `end`), or replace the whole file with
   `connector/workato_developer_api.custom_adapter.rb` (cumulative; CRLF like your original). Release the connector.
2. **Project property** `COLLABORATOR_ROLE` = `Analyst` (next to `CLIENT_ENVIRONMENT`). The workspace role the
   analyst receives. Any system role (Admin / Analyst / Operator) or a custom role spelled exactly as the target
   workspace spells it.
3. **Token scope.** `RTR_Secrets.dev_api_token` for each client workspace must come from an API client with DEV
   environment access and the collaborator privileges (an Admin-role client has them). The projects-mode rows use
   the same token the connector's TEST/PROD rows use — those are scoped per environment, so for TEST/PROD rows the
   runtime token must still be the DEV-scoped one of the base workspace. Easiest: seed `dev_api_token` for those rows
   with the DEV client token and let the action address the environment through `environment_type`.

## 1. POOL-16 Invite collaborator (new recipe function)

Folder RLCM. Trigger: **Recipe function → Execute**.

Parameters: `workspace_key` (string), `email` (string), `name` (string, optional), `correlation_id` (string).
Result: `ok` (boolean), `status` (string), `message` (string), `member_id` (string).

```
1  Data tables · Get records        RTR_Pool · workspace_key = ‹parameters › workspace_key› · limit 1
2  IF   ‹1 › records›.present? ? ‹1 › records›.length : 0   equals 0
   2a Return result                 ok = false, status = failed,
                                    message = "Workspace " + ‹workspace_key› + " is not in RTR_Pool."
3  Data tables · Get records        RTR_Secrets · workspace_key = ‹parameters › workspace_key› · limit 1
4  IF   ‹3 › records› is empty  OR  ‹3 › records › current item › dev_api_token› is blank
   4a Return result                 ok = false, status = failed,
                                    message = "No dev_api_token in RTR_Secrets for " + ‹workspace_key› + "; invite by hand."
5  Try
   5.1 Workato Developer API · Invite collaborator
         Target                    Another workspace (runtime)
         Target data center        ‹1 › records › current item › data_center›           (the API base URL)
         Target API token          ‹3 › records › current item › dev_api_token›         (enable data masking)
         Target label              ‹parameters › workspace_key›
         Email                     ‹parameters › email›
         Name                      ‹parameters › name›                                  (blank → derived)
         Environment type          =‹1 › records › current item › deployment_mode› == "projects"
                                      ? ‹1 › records › current item › target_environment›.to_s.downcase
                                      : "dev"
         Role                      ‹project property › COLLABORATOR_ROLE›
         Role type                 (blank)
   5.2 Return result               ok = true, status = ‹5.1 › status›, message = ‹5.1 › message›,
                                   member_id = ‹5.1 › member_id›.to_s
6  Catch   (retries 0)
   6a Return result                ok = false, status = failed,
                                   message = "Invite failed at step " + ‹catch › line_number›.to_s + ": " + ‹catch › error_message›
```

The action is idempotent by email (it looks the collaborator up first), so the function can be called again freely;
only a fresh invitation inside Workato's 20-minute window comes back as a 429, which lands in 6a with the
explanation in the message.

## 2. POOL-API-05 Claim a workspace — three additions

**Trigger (request body schema):** add two optional strings, `analyst_email` and `analyst_name`
(hint: "Analyst to invite to the claimed workspace. Blank = no invitation.").

**Trigger (200 response schema):** add an object `invite` with `attempted` (boolean), `status` (string),
`message` (string).

**Steps.** After step 11 (Update record → `bound`) and before step 12 (Return 200):

```
11a Variables · Declare             invite = { attempted: false, status: "skipped",
                                              message: "No analyst email on the claim; nobody invited." }
11b IF ‹trigger › body › analyst_email› is present
    11b.1 Call recipe POOL-16       workspace_key   = ‹8 › records › current item › workspace_key›
                                    email           = ‹trigger › body › analyst_email›
                                    name            = ‹trigger › body › analyst_name›
                                    correlation_id  = ‹trigger › body › correlation_id›
    11b.2 Variables · Update        invite.attempted = true
                                    invite.status    = ‹11b.1 › status›
                                    invite.message   = ‹11b.1 › message›
    11b.3 IF ‹11b.1 › ok› is not true                                  (optional, recommended)
          Data tables · Update record RTR_Pool, record = ‹8 › Record ID›
                                    last_error = "Analyst invitation failed: " + ‹11b.1 › message›
12  Return 200                      … existing fields …, invite = ‹variables › invite›
```

Why it sits here and not around the bind: the bind has already happened and the workbook settings are written by
the app next; an invitation problem must not undo either. 11b.3 surfaces it on the implementation row ("!" and
Need attention) without changing state; the claim still returns 200.

Timeout: the endpoint is at 30 s; the function adds two Developer API calls (≈1–2 s).

## 3. POOL-API-04 List workspaces — one field

In the 200 response schema add `link_to_workspace` (string, optional) and map it from the pool row in step 3.
The page already reads it (as `workspace_url`) to make the workspace name on an implementation row a link — until
now nothing populated it.

## Later: re-invite endpoint (not built)

`POST /workspaces/{workspace_key}/invite {email, name, correlation_id}` = trigger → call POOL-16 → return its
result. Three steps on top of POOL-16, plus `Registry.invite` in lib_sdc and an "Invite" button on the pool table.
Worth doing once you see the first blank-email claim or 20-minute collision in practice.

## Test

1. Claim from the web app with a workbook whose 1_customer has an analyst email that is **not** yet a collaborator →
   200, `invite.status = invited`, the analyst gets Workato's email; RTR_Pool row bound, no last_error.
2. Release, claim again with the same email → `already_member` (after they accepted) or a `failed` with the
   20-minute note (before); the claim itself succeeds either way.
3. Claim with a blank analyst email → `skipped`, message says so, nothing else differs.
4. Run POOL-16 directly with a role that doesn't exist → `failed`, message carries Workato's "Role … not found".
