Each state is a stop on one path, and only three recipes ever write it: POOL-01 (the orchestrator), the API recipes for claim/release/close, and the Router. Reading top to bottom is the life of a row.

| State | What it means | Written by | What happens next |
| --- | --- | --- | --- |
| `empty` | Row is seeded but nothing has been deployed into the workspace | Ops seeding (later also POOL-15 after a clean) | A `/prepare` |
| `queued` | A prepare *or* register job row exists; POOL-01 hasn't picked it up yet | POOL-API-01 / POOL-API-03 | POOL-01 starts within seconds |
| `deploying` | Prepare in progress: build golden (POOL-10), push custom connectors (POOL-11a), import the package (POOL-11) | POOL-01 step 8 | `configuring`, or `failed` |
| `configuring` | POOL-12 is writing the Data Tables token into the connection shells and setting project properties | POOL-01 step 23 | `needs_connections`, or straight on to `registering` if every connection authorised |
| `needs_connections` | Something in the target is still unauthorised (`pending_connections` lists them). The job ended *successfully*; a human (or the SA, after Decision 5) authorises, then calls `/register` | POOL-01 steps 29 / 37 | A `/register` |
| `registering` | Register in progress: API client + key (POOL-13), start recipes in order (POOL-14), enable endpoints, health check | POOL-01 step 41 | `available`, or `failed` |
| `available` | Freshly deployed golden, health check passed, nothing bound to it. The only state claim will take | POOL-01 step 60 (also release from `bound`) | A `/claim` |
| `bound` | A workbook has claimed it (`spreadsheet_id`, `client_name`, `bound_at` set) but nothing has been provisioned into the workspace yet. The Router accepts `/validate_configuration`, `/preview-template_file`, `/provision`; it rejects `/invitations` and `/portal-invite` with `NOT_PROVISIONED` | POOL-API-05 | First successful `/provision` |
| `active` | The engagement is live; every route is open | Router step 10 | `/close` |
| `inactive` | Engagement closed, `closed_at` stamped. The workspace still holds that client's data and recipes are still running. A claim with the same `spreadsheet_id` gets `WORKBOOK_CLOSED` | POOL-API-07 | `/release` (today → `available`; deferred → `needs_clean`) |
| `failed` | A prepare or register job died; `last_error` holds `{step, code, message}` and the job row says which step | POOL-09 | A `/prepare` or `/register` from here is allowed |

Three deferred states, once close and clean become jobs: `closing` (stop recipes, disable endpoints, then `inactive`), `needs_clean` (released from `inactive`, old data still present), `cleaning` (POOL-15 deleting the project, then `empty`).

For the app, the useful groupings are: **in flight** (`queued`, `deploying`, `configuring`, `registering` — keep polling), **waiting on a person** (`needs_connections`, `failed`), **claimable** (`available`), and **in an engagement** (`bound`, `active`, `inactive`). The library's poll rule already stops on the first two groups' terminal states (`available`, `needs_connections`, `failed`). Golden and dev rows walk the same states but have `deployment_mode = projects`, which is why the claim filter excludes them rather than a separate state.
