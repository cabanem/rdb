Here are all fifteen, including the two parked ones.

**POOL-API-01 Prepare** — Accepts a request to provision a workspace, checks the token row exists and the pool state permits it, and queues a job. It does no real work itself, because an endpoint has to answer in seconds and a build alone takes minutes.

**POOL-API-02 Status** — Returns the pool row for a workspace: state, pending connections, base URL, deployed package, and last error. It never calls the Developer API, so polling it can't trip a rate limit.

**POOL-API-03 Register** — The human-triggered second half of provisioning, called after someone has authorized the connections the gate left pending. It validates the state and queues a `register` job; a clean prepare never needs it.

**POOL-API-04 Clean** — Queues a teardown job for a workspace that is being released back to the pool. Specified, not built.

**POOL-01 Orchestrator** — Runs one job at a time from `RTR_PoolJobs` and sequences the functions below according to the job's command. It is the only recipe that writes `RTR_Pool.state`, so the entire state machine is readable top to bottom in this one recipe.

**POOL-09 Fail job** — Marks a job failed and the pool row with `{step, code, message}`. It exists because Stop job bypasses the error monitor, so an `ok = false` envelope needs an explicit write, and this keeps that to one step per check.

**POOL-10 Build golden package** — Builds the package (or project build) from golden on DEV and returns its ID without the binary. It is its own function because the fan-out needs one build for many imports, and a build failure needs no target-side cleanup.

**POOL-11a Ensure custom connectors** — Copies and releases every custom connector golden depends on into the target before import. Required in both deployment modes, since connectors are not deployable assets and RLCM refuses a package whose connectors are missing.

**POOL-11 Import package** — Deploys the package into the target's project, creating the project if needed, and writes the resulting folder, project and package IDs back to the pool row. Branches on deployment mode because projects-mode build and deploy are DEV-only endpoints; everything after it is mode-blind.

**POOL-12 Configure target** — Fills the connection shells the import created (service account into Google connections, the client's Developer API token into your own connector shells), sets per-workspace properties, and reports which connections still need a human. With re-authorize on, it doubles as key rotation.

**POOL-13 Register API client** — Creates or finds the API client and auth-token key on the target's collection and returns the token and base URL. Idempotent, but a rerun rotates the token, so the caller must store it immediately.

**POOL-14 Set recipe state in order** — Starts or stops the estate in topological order from `RTR_RecipeOrder`, resolving names to target-side IDs first. Start ascending, stop descending; the connector's paced batch action does the sequencing and verification.

**POOL-15 Clean workspace** — Inverse of provisioning: stops the recipes, deletes the API client, deletes the project and anything that survived, and resets the pool row only when the target is verified empty. First run is always a dry run. Specified, not built.

**POOL-02 Fan-out** — Builds golden once and queues a prepare job per active workspace with the package ID pre-filled, so each job skips its own build. This is "golden changed, roll it out," and it's why build and import are separate functions. Parked.

**RTR-API / Route** — Not part of provisioning, but the consumer of its output: the router forwards client requests to whichever workspace's base URL and token the pool registered. Mentioned only so the boundary is clear.
