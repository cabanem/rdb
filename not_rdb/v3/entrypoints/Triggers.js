/**
 * @file entrypoints/Triggers.gs
 * @author Emily Cabaniss (emily.cabaniss@randstadsourceright.com)
 *
 * Config-driven contract intake: Drive ingestion -> Gemini extraction -> per-contract review Sheet
 * -> human correction -> Workato webhook push -> Salesforce.
 *
 * ARCHITECTURE (two time-driven loops, one project, nothing embedded in artifacts)
 *   processIngestion()   polls the ingestion folder, extracts, writes a review Sheet into the pending folder (Approved column
 *                        pre-typed from the cached Salesforce schema: dropdowns, checkboxes, date pickers, highlights — ReviewSheet.gs),
 *                        pings Chat.
 *   processApprovals()   polls the pending folder, and for any sheet whose "Approved?" box is ticked, types and validates the
 *                        APPROVED column against the cached Salesforce schema (Gate.gs), builds a payload and POSTs it to Workato. Whatever is still in pending afterwards is written to the
 *                        `_queue` tab as a snapshot (Snapshot.gs). Both loops stamp a heartbeat cell when they finish.
 *   doGet()              (entrypoints/WebApp.gs) serves Dashboard.html, a read-only home base over `_queue` and `_logs`.
 *
 * The review Sheet is a plain spreadsheet with no bound code and no auth of its own. The reviewer reads it,
 * corrects the Approved column, ticks the box. The central poller does the rest. This is what keeps approval
 * a *value* the human sets rather than code that runs inside each artifact.
 *
 * SOURCE OF TRUTH
 *   The Approved column is the truth that gets pushed. The Extracted column is frozen at extraction time and never edited,
 *   so the delta between the two is a free audit trail and travels in the payload as provenance.
 *
 * DELIVERY GUARANTEE
 *   Extraction is at-least-once. The only duplicate window is a crash between "review sheet created" and "original moved out
 *   of ingestion" -- rare, and it produces a visible duplicate review sheet a human can delete. The push is effectively exactly-once:
 *   a correlation_id minted at sheet creation rides every attempt, so Workato/Salesforce can upsert on it. If we need exactly-once extraction,
 *   tag each review sheet with the source fileId via the Advanced Drive Service appProperties and check before create. Not built.
 *
 * BINDING / SCOPES
 *   Bind this project to the Config spreadsheet (Extensions > Apps Script from that sheet), or set Script Property CONFIG_SHEET_ID and switch
 *   getConfigSpreadsheet_() to openById. appsscript.json must include:
 *   - https://www.googleapis.com/auth/cloud-platform           (Vertex)
 *   - https://www.googleapis.com/auth/spreadsheets
 *   - https://www.googleapis.com/auth/drive
 *   - https://www.googleapis.com/auth/documents                (Word -> text)
 *   - https://www.googleapis.com/auth/script.external_request
 *
 *   The Advanced Drive Service is required ONLY if we ingest .docx/.doc.
 *
 * SETUP
 *   Run setupTriggers() once to install both time-driven loops.
 *   For the dashboard, deploy the project as a web app (steps in the WebApp.gs header).
 *
 */

// --- CONSTANTS -----------------------------------------------------------------------------------
/** @const {number} Polling cadence for both loops. setupTriggers() installs it; the dashboard uses it to judge heartbeat staleness. */
const POLL_MINUTES = 5;

// --- TIME-DRIVEN LOOPS ---------------------------------------------------------------------------
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
    const schema = loadSchema_();                            // {} until `_schema` has been refreshed; sheets then get no dropdowns
    const extractor = vertexExtractor_();                    // the model call, and the identity behind it (adapters/Vertex.gs)

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
        const sheet = extractOneFile_(file, cfg, pending, schema, extractor);   // create review sheet first
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

/**
 * Time-driven entry point: push any approved review sheet to Workato, then snapshot what remains.
 * Serialized with the script lock. Every sheet the loop visits and does not push (unticked, or push failed)
 * becomes one row of the `_queue` snapshot; the snapshot is written wholesale after the loop, then the heartbeat.
 * @return {void}
 */
function processApprovals() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    const cfg = readConfig_();
    assertFolderAccess_(cfg, ['folder_id_pending', 'folder_id_pushed', 'folder_id_cancelled']);
    const chat = new ChatNotifier(cfg.chat_webhook_url);
    const schema = loadSchema_();                            // {} until `_schema` has been refreshed; the gate then passes through

    const pending = DriveApp.getFolderById(cfg.folder_id_pending);
    const pushed = DriveApp.getFolderById(cfg.folder_id_pushed);
    const cancelled = DriveApp.getFolderById(cfg.folder_id_cancelled);

    const queue = [];                                        // what is still in pending after this run
    const sheets = pending.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (sheets.hasNext()) {
      const driveFile = sheets.next();
      const name = driveFile.getName();
      const url = driveFile.getUrl();
      let approval = null;
      try {
        const ss = SpreadsheetApp.openById(driveFile.getId());
        approval = readApproval_(ss);

        const action = nextAction_(approval);
        if (action === 'cancel') {
          markCancelled_(ss);
          moveFile_(driveFile, cancelled);
          logInfo_('processApprovals', 'Cancelled ' + name, approval.correlationId, url);
          continue;
        }
        if (action === "wait") {
          if (approval.status === 'Cancelled') { markPending_(ss); approval.status = 'Pending Review'; }
          queue.push(queueRow_(name, url, approval));
          continue;
        }

        const gate = validateApproval_(approval, cfg, schema);   // Gate.gs: typed values, or every bad cell at once
        if (!gate.ok) {                                       // sheet stays pending; the cells and Last error say why
          try { markCellErrors_(ss, gate.errors); } catch (e) { logWarn_('processApprovals', 'Could not mark cells', approval.correlationId, e.message); }
          throw new Error(gate.message);
        }
        try { clearCellErrors_(ss); } catch (e) { }           // a previous attempt's red cells are now resolved
        pushToWorkato_(approval, cfg, gate.fields);          // throws on non-2xx
        markPushed_(ss);
        moveFile_(driveFile, pushed);                        // remove from the queue
        logInfo_('processApprovals', 'Pushed ' + name, approval.correlationId, url);
      } catch (err) {
        // A sheet that fails the same way on every poll is logged and announced once; the `_queue` row and the
        // sheet's Last error cell still show it every run.
        const repeat = !!(approval && approval.lastError && approval.lastError === String(err.message).slice(0, REVIEW_ERROR_MAX));
        try { markError_(SpreadsheetApp.openById(driveFile.getId()), err.message); } catch (e) { }
        queue.push(queueRow_(name, url, approval, err.message));
        if (!repeat) {
          logError_('processApprovals', 'Push failed: ' + name, approval ? approval.correlationId : '', err.message);
          chat.text('Push FAILED for *' + name + '*: ' + err.message);
        }
      }
    }
    writeQueueSnapshot_(queue);
    heartbeat_(HEARTBEAT.APPROVALS);
  } catch (err) {
    logError_('processApprovals', 'Run failed', '', err.message);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// --- DRIVE HELPER --------------------------------------------------------------------------------
/**
 * Move a file to a folder.
 * @param {GoogleAppsScript.Drive.File} file
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @private
 */
function moveFile_(file, folder) { file.moveTo(folder); }

// --- SETUP ---------------------------------------------------------------------------------------
/**
 * Install both polling triggers (clearing any prior copies first). Run once.
 * @return {void}
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'processIngestion' || fn === 'processApprovals') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processIngestion').timeBased().everyMinutes(POLL_MINUTES).create();
  ScriptApp.newTrigger('processApprovals').timeBased().everyMinutes(POLL_MINUTES).create();
  setupSchemaTrigger();                                     // daily `_schema` refresh; idempotent (Schema.gs)
}
