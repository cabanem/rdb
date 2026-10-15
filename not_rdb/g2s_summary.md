It's a reference for checking a change against, not a narrative. Ten sections in one tab:

**Scope** — what the doc is and how to read the contract tables: Pre (what must be true), Effects (side effects in order, since order decides crash state), On failure (thrown vs. swallowed, and which channel carries it), Leaves (durable state after a normal run).

**Time-driven entry points** — one contract table each for `processIngestion`, `processApprovals`, and `refreshSchema`: lock behaviour, folder preconditions, the numbered sequence per file or sheet, per-item vs. run-level failure handling, the heartbeat rule, the documented duplicate window, and the correlation-id idempotency story.

**Web app and dashboard endpoints** — the seven `google.script.run` functions plus `doGet` in one table: identity, preconditions, effects, failure path, and the exact return shape each sends to the browser. Ends with the locked-keys rule.

**Manual and menu entry points** — `setupTriggers`, access and config checks, model refresh, the hermetic test runner, and the live Workato probes, flagged where they touch Salesforce.

**Config tab** — every key with its parse type, drawer type, required-ness, default, who reads it, and whether it's locked; notes the keys read but not shown and shown but not read, and that model defaults live in `callGemini_` rather than `parseConfig_`.

**Review sheet** — the row-by-row layout of the meta block, grid, and sources block, who writes and reads each, the status vocabulary, and the per-type cell affordances the schema adds.

**Machine-owned tabs** — `_logs`, `_queue`, `_schema`, `_models`: writer, mode (append vs. overwrite), readers, positional layout, and the log-message prefixes the dashboard counts depend on.

**Workato payload and the wire-key join** — the JSON body, headers, typed vs. raw fields, how `toSnake_` and the `=>` alias produce the one key shared by payload, cache, and recipe, and the schema endpoint's expected response.

**Gate normalization rules** — the two-pass structure, a per-Salesforce-type table (accepts / emits / fails when), dependent-picklist checking, the time-zone rule for dates, and why review-sheet seeding and the gate can't disagree.

**Identity, secrets, and scopes** — the single runner identity, visitor identification, Script Properties, OAuth scopes and what each enables, the dev-mode library pin, and a per-run cost sketch.

**Dashboard client** — state objects, the load/render cycle, derived display rules, upload and picker flows, the seven-step settings drawer, and what the client deliberately never does.

**Not covered here** — ConfigEditor's per-field coercions, retired code still compiling, duplicated helpers, and the test coverage boundary.
