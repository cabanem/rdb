# Wiring — Access.gs + Claim.gs into the host project

Two new files (`Access.js`, `Claim.js`) and **four edits** to existing files. No manifest change: the Advanced Drive
Service v3 is already enabled and `drive` is already in `oauthScopes`.

| File | Edit |
|---|---|
| `ContractIntake.js` | `processIngestion()` — full replacement below |
| `ContractIntake.js` | `processApprovals()` — one line added after `readConfig_()` |
| `Intake.js` | `countIntakeFiles_()` — skip claimed originals |
| `ConfigTools.js` | `onOpen()` — one menu item |

`createReviewSheet_` and everything else stay as they are. (`createInPlace_` in Access.gs is only worth switching to if
the tree ever moves to a shared drive; in My Drive the create-then-move it replaces works fine.)

---

## 1. `ContractIntake.js` — `processIngestion()` (replace whole function)

```js
/**
 * Time-driven entry point: ingest → extract → write review sheet → claim original → notify → heartbeat.
 * Serialized with the script lock so runs never overlap. A run-level failure (readConfig_ or the folder-access
 * check throwing) is logged and re-thrown: the log row shows up on the dashboard, the re-throw keeps Apps Script's
 * own failure notification, and the heartbeat is deliberately NOT stamped so it goes visibly stale.
 *
 * Originals the runner does not own (dropped straight into Intake by someone else) cannot always be moved; see
 * Claim.gs. claimOriginal_ moves when it can and copies when it cannot, and isClaimed_ keeps a copied original
 * from being re-extracted on the next poll.
 * @return {void}
 */
function processIngestion() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;            // a run is already in flight; skip
  try {
    const cfg = readConfig_();
    assertFolderAccess_(cfg, ['folder_id_ingestion', 'folder_id_processed', 'folder_id_failed', 'folder_id_pending']);
    const chat = new ChatNotifier(cfg.chat_webhook_url);

    const ingestion = DriveApp.getFolderById(cfg.folder_id_ingestion);
    const processed = DriveApp.getFolderById(cfg.folder_id_processed);
    const failed = DriveApp.getFolderById(cfg.folder_id_failed);
    const pending = DriveApp.getFolderById(cfg.folder_id_pending);

    const files = ingestion.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (isClaimed_(file)) continue;                        // copied on a prior poll; the owner's original is still here
      const name = file.getName();
      try {
        const sheet = extractOneFile_(file, cfg, pending);   // create review sheet first
        const kept = claimOriginal_(file, processed);        // then claim the original: move, or copy if Drive refuses
        if (kept.getId() !== file.getId()) repointSheet_(sheet.id, kept);
        notifyReview_(chat, sheet.url, name);
        logInfo_('processIngestion', 'Staged ' + name, sheet.correlationId, sheet.url);
      } catch (err) {
        logError_('processIngestion', 'Extract failed: ' + name, '', err.message);
        try { claimOriginal_(file, failed); } catch (e) { /* leave in ingestion to retry */ }
        chat.text('Contract extraction FAILED for *' + name + '*: ' + err.message);
      }
    }
    heartbeat_(HEARTBEAT.INGESTION);
  } catch (err) {
    logError_('processIngestion', 'Run failed', '', err.message);
    throw err;
  } finally {
    lock.releaseLock();
  }
}
```

What changed versus the current function, line by line:

- `assertFolderAccess_(cfg, [...])` after `readConfig_()` — the four folders this loop touches.
- `if (isClaimed_(file)) continue;` at the top of the loop.
- `claimOriginal_(file, processed)` replaces `moveFile_(file, processed)`; its return value is the file that now lives in
  Processed (the original on a move, the copy otherwise).
- `repointSheet_(sheet.id, kept)` when the kept file is not the original.
- `claimOriginal_(file, failed)` replaces `moveFile_(file, failed)` in the catch.

Everything else — ordering, the lock, the heartbeat, the Chat card, the log lines — is unchanged.

---

## 2. `ContractIntake.js` — `processApprovals()` (one line)

Immediately after `const cfg = readConfig_();`:

```js
    assertFolderAccess_(cfg, ['folder_id_pending', 'folder_id_pushed', 'folder_id_cancelled']);
```

Nothing else in this loop changes: every file it moves is a review sheet the runner created, so `moveFile_` stays.

---

## 3. `Intake.js` — `countIntakeFiles_()` (replace whole function)

```js
/**
 * Files in the Intake folder right now that have NOT yet been read (claimed-by-copy originals are skipped, since
 * their copy already lives in Processed). One listing; null on any problem.
 * @return {?number}
 * @private
 */
function countIntakeFiles_() {
  try {
    const it = DriveApp.getFolderById(readConfig_().folder_id_ingestion).getFiles();
    let n = 0;
    while (it.hasNext()) { if (!isClaimed_(it.next())) n++; }
    return n;
  } catch (e) {
    return null;
  }
}
```

---

## 4. `ConfigTools.js` — `onOpen()` (one menu item)

```js
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Contract Intake')
      .addItem('Refresh model list', 'refreshModelList')
      .addItem('Validate config', 'validateConfigUi')
      .addItem('Check folder access', 'checkAccessUi')
      .addToUi();
  } catch (e) { /* no UI (editor run, or not bound) */ }
}
```

---

## Order of operations after `clasp push`

1. Triggers off (if not already).
2. Config → the six folder IDs.
3. Config sheet → **Contract Intake → Check folder access**. Six `OK` lines. A `note:` line about ownership is
   informational; a `FAIL` line names the folder and what the runner cannot do on it.
4. Editor → run `processIngestion()` by hand with one test PDF in Intake. Expect: review sheet in Pending, PDF in
   Processed (or a copy there plus a `Copied (not moved)` log row, if the PDF was someone else's).
5. Tick Approved on the sheet → run `processApprovals()` by hand against `workato_test_url`.
6. `setupTriggers()`.

## Behaviour to expect from `assertFolderAccess_`

It runs at the top of each poll. When a folder stops being usable (unshared, trashed, wrong ID), the run fails at
that line with a message naming the folder — before any file is touched — and the heartbeat goes stale. The dashboard
shows the `_logs` row; Apps Script sends its usual failure mail. Fourteen Drive reads per poll cycle, well inside quota.
