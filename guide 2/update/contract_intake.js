/**
 * @file ContractIntake.gs
 * @author Emily Cabaniss (emily.cabaniss@randstadsourceright.com)
 *
 * Config-driven contract intake: Drive ingestion -> Gemini extraction -> per-contract review Sheet
 * -> human correction -> Workato webhook push -> Salesforce.
 *
 * ARCHITECTURE (two time-driven loops, one project, nothing embedded in artifacts)
 *   processIngestion()   polls the ingestion folder, extracts, writes a review Sheet into the pending folder, pings Chat.
 *   processApprovals()   polls the pending folder, and for any sheet whose "Approved?" box is ticked, builds a payload from the
 *                        APPROVED column and POSTs it to Workato. Whatever is still in pending afterwards is written to the
 *                        `_queue` tab as a snapshot (Snapshot.gs). Both loops stamp a heartbeat cell when they finish.
 *   doGet()              (WebApp.gs) serves Dashboard.html, a read-only home base over `_queue` and `_logs`.
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


// --- SHARED TYPE DEFINITIONS AND SHAPES ----------------------------------------------------
/**
 * Typed view of the Config tab.
 * @typedef {Object} Config
 * @property {string}           folder_id_ingestion   Drop folder for incoming contracts.
 * @property {string}           folder_id_processed   Originals land here after extraction.
 * @property {string}           folder_id_failed      Originals land here on failure.
 * @property {string}           folder_id_pending     Review sheets awaiting approval.
 * @property {string}           folder_id_pushed      Review sheets after a successful push.
 * @property {string}           folder_id_cancelled   Review sheets after a reviewer selects "Cancel?"
 * @property {string}           prompt_template       Extraction prompt prefix.
 * @property {string[]}         output_fields         Fields to extract, in display order.
 * @property {string}           system_instruction    Optional system instruction.
 * @property {string}           project_id            GCP project for Vertex.
 * @property {string}           location              Vertex location ('global' default).
 * @property {string}           model                 Model id (gemini-2.5-pro default).
 * @property {number|undefined} temperature           Sampling temperature, if set.
 * @property {number|undefined} max_tokens            Max output tokens, if set.
 * @property {boolean}          grounding             Attach Google Search grounding.
 * @property {boolean}          grounding_debug       Dump grounding metadata keys.
 * @property {string}           workato_webhook_url   Push target.
 * @property {string}           workato_shared_secret Optional webhook auth secret.
 * @property {string}           chat_webhook_url      Optional Google Chat webhook.
 * @property {string[]}         upload_allowed_emails Lower-cased emails allowed to upload from the dashboard; [] = anyone who can open it.
 * @property {string[]}         config_allowed_emails Lower-cased emails allowed to edit Config from the dashboard; [] = the deployer only.
 * @property {string}           guide_url             Optional. Where the user guide lives; shown as a "Guide" link in the dashboard header when set.
 * @property {string}           picker_url            Optional. /exec URL of the DrivePicker helper web app. Present = "Add from Drive" on.
 * @property {string}           support_contact       Optional. Who the dashboard tells people to ask for access or help.
 */

/**
 * A Gemini `contents[].parts[]` entry: either {text} or {inlineData:{...}}.
 * @typedef {Object} ContentPart
 */

/**
 * Structured result of one Gemini call.
 * @typedef {Object} GeminiResult
 * @property {string} text    Concatenated text from the first candidate.
 * @property {string} sources Grounding sources, "title — uri" per line; '' if none.
 * @property {string} debug   Grounding metadata key dump when debug is on; '' otherwise.
 */

/**
 * Reference to a freshly created review Sheet.
 * @typedef {Object} ReviewSheetRef
 * @property {string} id            Spreadsheet id.
 * @property {string} url           Spreadsheet url.
 * @property {string} correlationId Idempotency key minted for this contract.
 */

/**
 * Read-back of a review Sheet's approval state and values.
 * @typedef {Object} Approval
 * @property {boolean} approved      Whether the "Approved?" box is ticked.
 * @property {boolean} cancelled     Whether the "Cancel?" box is ticked.
 * @property {string}  correlationId Idempotency key for the push.
 * @property {string}  fileId        Source Drive file id.
 * @property {string}  fileName      Source Drive file name.
 * @property {string}  model         Model used at extraction.
 * @property {string}  extractedAt   ISO timestamp of extraction.
 * @property {string}  status        Status cell: 'Pending Review' | 'Pushed' | 'Error'.
 * @property {string}  lastError     Last Error cell; '' if the sheet has never errored.
 * @property {Object.<string,string>} fields    Human-approved values (pushed).
 * @property {Object.<string,string>} extracted Original extracted values (audit).
 */
// -------------------------------------------------------------------------------------------

// --- CONSTANTS -----------------------------------------------------------------------------
/** @const {string} Name of the configuration tab. */
const CONFIG_SHEET_NAME = 'Config';
/** @const {string}  Name of the review tab within each review spreadsheet.*/
const REVIEW_SHEET_TAB = 'Review';

/**
 * Review-sheet metadata labels (column A). Reads are label-scanned, not by row
 * index, so light hand-edits to the sheet don't break the approval reader.
 * @const {Object.<string,string>}
 */
const META = {
  ORIGINAL: 'Original file',
  SOURCE_ID: 'Source file ID',
  SOURCE_NAME: 'Source file name',
  CORRELATION: 'Correlation ID',
  EXTRACTED: 'Extracted at',
  MODEL: 'Model',
  STATUS: 'Status',
  APPROVED: 'Approved?',
  PUSHED_AT: 'Pushed at',
  CANCEL: 'Cancel?',
  CANCELLED_AT: 'Cancelled at',
  ERROR: 'Last error',
  SOURCES: 'Grounding sources'
};
/** @const {string[]} Header row of the field grid. */
const GRID_HEADER = ['Field', 'Extracted', 'Approved'];
/** @const {number} Largest PDF (raw bytes) we send to Gemini inline. */
const INLINE_PDF_MAX_BYTES = 15 * 1024 * 1024;
/** @const {number} Polling cadence for both loops. setupTriggers() installs it; the dashboard uses it to judge heartbeat staleness. */
const POLL_MINUTES = 5;

// --- ENTRY POINTS --------------------------------------------------------------------------
/**
 * Time-driven entry point: ingest → extract → write review sheet → notify → heartbeat.
 * Serialized with the script lock so runs never overlap. A run-level failure (e.g. readConfig_ throwing) is
 * logged and re-thrown: the log row shows up on the dashboard, the re-throw keeps Apps Script's own failure
 * notification, and the heartbeat is deliberately NOT stamped so it goes visibly stale.
 * @return {void}
 */
function processIngestion() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;            // a run is already in flight; skip
  try {
    const cfg = readConfig_();
    const chat = new ChatNotifier(cfg.chat_webhook_url);

    const ingestion = DriveApp.getFolderById(cfg.folder_id_ingestion);
    const processed = DriveApp.getFolderById(cfg.folder_id_processed);
    const failed = DriveApp.getFolderById(cfg.folder_id_failed);
    const pending = DriveApp.getFolderById(cfg.folder_id_pending);

    const files = ingestion.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = file.getName();
      try {
        const sheet = extractOneFile_(file, cfg, pending);   // create review sheet first
        moveFile_(file, processed);                          // then claim the original
        notifyReview_(chat, sheet.url, name);
        logInfo_('processIngestion', 'Staged ' + name, sheet.correlationId, sheet.url);
      } catch (err) {
        logError_('processIngestion', 'Extract failed: ' + name, '', err.message);
        try { moveFile_(file, failed); } catch (e) { /* leave in ingestion to retry */ }
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
    const chat = new ChatNotifier(cfg.chat_webhook_url);

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

        pushToWorkato_(approval, cfg);                       // throws on non-2xx
        markPushed_(ss);
        moveFile_(driveFile, pushed);                        // remove from the queue
        logInfo_('processApprovals', 'Pushed ' + name, approval.correlationId, url);
      } catch (err) {
        logError_('processApprovals', 'Push failed: ' + name, approval ? approval.correlationId : '', err.message);
        try { markError_(SpreadsheetApp.openById(driveFile.getId()), err.message); } catch (e) { }
        queue.push(queueRow_(name, url, approval, err.message));
        chat.text('Push FAILED for *' + name + '*: ' + err.message);
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


// --- EXTRACTION ----------------------------------------------------------------------------
/**
 * Extract one file, parse its fields, and write the review sheet into `pending`.
 * @param {GoogleAppsScript.Drive.File} file Source contract.
 * @param {Config} cfg Pipeline configuration.
 * @param {GoogleAppsScript.Drive.Folder} pendingFolder Destination for the review sheet.
 * @return {ReviewSheetRef}
 * @private
 */
function extractOneFile_(file, cfg, pendingFolder) {
  const parts = buildExtractionParts_(file);              // [{text}] or [{inlineData}]
  const prompt = cfg.prompt_template + fieldInstruction_(cfg.output_fields);

  const result = callGemini_(cfg, prompt, parts);      // {text, sources, debug}
  const parsedData = parseResult_(result.text, cfg.output_fields);

  return createReviewSheet_(parsedData, file, result.sources, cfg, pendingFolder);
}
/**
 * Turn a Drive file into Gemini content parts.
 *   - PDF        → inline base64 (native document understanding; keeps tables).
 *   - Google Doc → plain text (cheap, lossless).
 *   - Word       → converted to a temp Google Doc, text extracted, temp trashed.
 * No OCR step: PDFs go to the model whole; Word conversion is a format change.
 * @param {GoogleAppsScript.Drive.File} file
 * @return {ContentPart[]}
 * @throws {Error} If the file is too large to inline or an unsupported type.
 * @private
 */
function buildExtractionParts_(file) {
  const mime = file.getMimeType();

  if (mime === MimeType.GOOGLE_DOCS) {
    return [{ text: DocumentApp.openById(file.getId()).getBody().getText() }];
  }

  if (mime === MimeType.PDF) {
    const bytes = file.getBlob().getBytes();
    if (bytes.length > INLINE_PDF_MAX_BYTES) {
      throw new Error('PDF too large for inline extraction (' +
        Math.round(bytes.length / 1048576) + 'MB). Route via GCS fileData.');
    }
    return [{ inlineData: { mimeType: 'application/pdf', data: Utilities.base64Encode(bytes) } }];
  }

  if (mime === MimeType.MICROSOFT_WORD || mime === 'application/msword') {
    return [{ text: wordToText_(file) }];
  }

  throw new Error('Unsupported file type (' + mime + ') for ' + file.getName());
}
/**
 * Convert .docx/.doc to text via a throwaway Google Doc. Requires the Advanced
 * Drive Service. The temp doc is always trashed, even on failure.
 * @param {GoogleAppsScript.Drive.File} file
 * @return {string}
 * @private
 */
function wordToText_(file) {
  let tempId = null;
  try {
    const created = Drive.Files.create(
      { name: file.getName() + ' (temp)', mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob()
    );
    tempId = created.id;
    return DocumentApp.openById(tempId).getBody().getText();
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); }
      catch (e) { console.warn('Temp doc not trashed: ' + tempId); }
    }
  }
}
/**
 * Flatten grounding chunks to "title — uri" lines, deduped by uri.
 * @param {Object} meta The candidate's groundingMetadata (may be undefined).
 * @return {string} One source per line, or '' if ungrounded.
 * @private
 */
function extractSources_(meta) {
  const chunks = meta && meta.groundingChunks;
  if (!chunks || !chunks.length) return '';
  const seen = {};
  const lines = [];
  chunks.forEach(function (c) {
    const w = c && c.web;
    if (w && w.uri && !seen[w.uri]) {
      seen[w.uri] = true;
      lines.push((w.title || w.uri) + ' — ' + w.uri);
    }
  });
  return lines.join('\n');
}
/**
 * Instruction appended to the prompt that makes the response field-parseable
 * via [[Label]] delimiters.
 * @param {string[]} fields Field labels, in order.
 * @return {string}
 * @private
 */
function fieldInstruction_(fields) {
  const labels = fields.map(function (f) { return '[[' + f + ']]'; }).join('\n');
  return '\n\n---\nFormat your entire response as labeled sections. Begin each ' +
    "section with its label on its own line, exactly as written below " +
    '(double square brackets), then that section\'s content. Use these ' +
    'labels, in this order:\n' + labels +
    '\n\nDo not use the [[ ]] notation anywhere except as these labels. ' +
    'If a field is not present in the contract, leave its section empty.';
}
/**
 * Split a [[Label]]-delimited response into a field→content map. Tolerant of
 * markdown around labels and label order. If nothing matches, the whole body is
 * placed in the first field so no text is ever lost.
 * @param {string} text Raw model text.
 * @param {string[]} fields Expected field labels.
 * @return {Object.<string,string>} Every field present; unmatched ones blank.
 * @private
 */
function parseResult_(text, fields) {
  const body = String(text);
  const hits = [];
  fields.forEach(function (f) {
    const re = new RegExp('(?:^|\\n)[ \\t>*#-]*\\[\\[\\s*' + escapeRegex_(f) + '\\s*\\]\\][ \\t:*]*', 'i');
    const m = re.exec(body);
    if (m) hits.push({ field: f, start: m.index, contentStart: m.index + m[0].length });
  });
  hits.sort(function (a, b) { return a.start - b.start; });

  const out = {};
  hits.forEach(function (h, i) {
    const end = (i + 1 < hits.length) ? hits[i + 1].start : body.length;
    out[h.field] = body.slice(h.contentStart, end).trim();
  });
  fields.forEach(function (f) { if (!(f in out)) out[f] = ''; });   // missing -> blank
  if (hits.length === 0 && fields.length) out[fields[0]] = body.trim();  // never lose text
  return out;
}
/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} s
 * @return {string}
 * @private
 */
function escapeRegex_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Deterministic label --> API key: lowercase, runs of non-alphanumerics -> '_', edges trimmed.
 *
 * @param {string} label
 * @return {string}
 * @private
 */
function toSnake_(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Rekey an object's properties through toSnake_.
 * @param {Object.<string,*>} obj
 * @return {Object.<string,*>}
 * @private
 */
function snakeKeys_(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) { out[toSnake_(k)] = obj[k]; });
  return out;
}


// --- GEMINI --------------------------------------------------------------------------------
/**
 * Vertex seam. Builds the request, fires it, and delegates response interpretation to {@link interpretGeminiResponse_}
 * (kept pure so the branch logic is unit-testable). Auth uses the running user's OAuth token.
 * @param {Config} cfg
 * @param {string} promptText Prompt that precedes the file content parts.
 * @param {ContentPart[]} contentParts File content (text or inline document).
 * @return {GeminiResult}
 * @throws {Error} On transport or non-text outcomes (safety/recitation/empty).
 * @private
 */
function callGemini_(cfg, promptText, contentParts) {
  if (!cfg.project_id) throw new Error('Config missing "project_id".');
  const location = cfg.location || 'global';
  const model = cfg.model || 'gemini-2.5-pro';
  const host = (location === 'global')
    ? 'aiplatform.googleapis.com'
    : location + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + cfg.project_id +
    '/locations/' + location + '/publishers/google/models/' +
    model + ':generateContent';

  const body = {
    contents: [{ role: 'user', parts: [{ text: promptText }].concat(contentParts) }],
    generationConfig: {
      temperature: (cfg.temperature == null ? 0.2 : cfg.temperature),
      maxOutputTokens: (cfg.max_tokens == null ? 8192 : cfg.max_tokens)
    }
  };
  if (cfg.system_instruction) body.systemInstruction = { parts: [{ text: cfg.system_instruction }] };
  if (cfg.grounding) body.tools = [{ googleSearch: {} }];

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var json = JSON.parse(resp.getContentText());
  return interpretGeminiResponse_(resp.getResponseCode(), json, cfg.grounding_debug);
}
/**
 * Pure interpretation of a Vertex generateContent response. Throws on non-text
 * outcomes so a blocked/empty extraction is NOT silently staged as a clean one
 * (the "no poison success" guarantee).
 * @param {number} code HTTP status code.
 * @param {Object} json Parsed response body.
 * @param {boolean} groundingDebug Whether to surface a grounding key dump.
 * @return {GeminiResult}
 * @throws {Error} On non-200, no candidates, SAFETY, RECITATION, or empty text.
 * @private
 */
function interpretGeminiResponse_(code, json, groundingDebug) {
  if (code !== 200) {
    throw new Error('Vertex ' + code + ': ' +
      ((json.error && json.error.message) || JSON.stringify(json)));
  }
  var cand = json.candidates && json.candidates[0];
  if (!cand) throw new Error('Gemini returned no candidates.');
  if (cand.finishReason === 'SAFETY') throw new Error('Gemini blocked: safety.');
  if (cand.finishReason === 'RECITATION') throw new Error('Gemini blocked: recitation.');
  var text = ((cand.content && cand.content.parts) || [])
    .map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  var debug = groundingDebug
    ? (cand.groundingMetadata
      ? 'keys=' + JSON.stringify(Object.keys(cand.groundingMetadata))
      : '(no groundingMetadata)')
    : '';
  return { text: text, sources: extractSources_(cand.groundingMetadata), debug: debug };
}


// --- REVIEW SHEET --------------------------------------------------------------------------
/**
 * Build the per-contract review Sheet in `pending`. Fields are written in CONFIG
 * order (not parse order) so the reviewer always sees a stable layout. A
 * correlation_id is minted here and travels with the contract through the push.
 * @param {Object.<string,string>} parsedData Extracted field values.
 * @param {GoogleAppsScript.Drive.File} file Source contract.
 * @param {string} sources Grounding sources (may be '').
 * @param {Config} cfg
 * @param {GoogleAppsScript.Drive.Folder} pendingFolder
 * @return {ReviewSheetRef}
 * @private
 */
function createReviewSheet_(parsedData, file, sources, cfg, pendingFolder) {
  const ss = SpreadsheetApp.create('Contract Review: ' + file.getName());
  const sheet = ss.getSheets()[0].setName(REVIEW_SHEET_TAB);

  const corr = Utilities.getUuid();
  const meta = [
    [META.ORIGINAL, '=HYPERLINK("' + file.getUrl() + '","' + file.getName().replace(/"/g, "'") + '")'],
    [META.SOURCE_ID, file.getId()],
    [META.SOURCE_NAME, file.getName()],
    [META.CORRELATION, corr],
    [META.EXTRACTED, new Date().toISOString()],
    [META.MODEL, cfg.model || 'gemini-2.5-pro'],
    [META.STATUS, 'Pending Review'],
    [META.APPROVED, false],
    [META.CANCEL, false]
  ];
  meta.forEach(function (pair, i) {
    sheet.getRange(i + 1, 1).setValue(pair[0]).setFontWeight('bold');
    const cell = sheet.getRange(i + 1, 2);
    if (pair[0] === META.ORIGINAL) cell.setFormula(pair[1]);
    else cell.setValue(pair[1]);
  });
  // Make "Approved?" and "Cancel?" real checkboxes, found by label so reordering the block cannot break them.
  [META.APPROVED, META.CANCEL].forEach(function (label) {
    const i = meta.findIndex(function (pair) { return pair[0] === label; });
    sheet.getRange(i + 1, 2).insertCheckboxes();
    if (label === META.CANCEL) {
      sheet.getRange(i + 1, 2).setNote('Tick this instead of Approved? to withdraw the contract. Nothing is sent, and the sheet moves to the adjacent Cancelled folder.');
    }
  });

  // Field grid: Field | Extracted | Approved (Approved seeded from Extracted).
  const headerRow = meta.length + 2;
  sheet.getRange(headerRow, 1, 1, 3).setValues([GRID_HEADER]).setFontWeight('bold');
  const rows = cfg.output_fields.map(function (f) {
    const v = parsedData[f] || '';
    return [f, v, v];
  });
  if (rows.length) sheet.getRange(headerRow + 1, 1, rows.length, 3).setValues(rows);

  // Sources block below the grid (provenance, read-only by convention).
  const srcRow = headerRow + rows.length + 2;
  sheet.getRange(srcRow, 1).setValue(META.SOURCES).setFontWeight('bold');
  sheet.getRange(srcRow, 2).setValue(sources || '(none)');

  sheet.setColumnWidth(1, 220).setColumnWidth(2, 420).setColumnWidth(3, 420);
  sheet.setFrozenRows(headerRow);
  SpreadsheetApp.flush();

  moveFile_(DriveApp.getFileById(ss.getId()), pendingFolder);
  return { id: ss.getId(), url: ss.getUrl(), correlationId: corr };
}
/**
 * Read approval state and the human-approved values from a review sheet.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The review spreadsheet.
 * @return {Approval}
 * @private
 */
function readApproval_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];

  const approved = readMeta_(sheet, META.APPROVED) === true;
  const cancelled = readMeta_(sheet, META.CANCEL) === true;
  const corr = readMeta_(sheet, META.CORRELATION);
  const fileId = readMeta_(sheet, META.SOURCE_ID);
  const fileName = readMeta_(sheet, META.SOURCE_NAME);
  const model = readMeta_(sheet, META.MODEL);
  const extAt = readMeta_(sheet, META.EXTRACTED);
  const status = str_(readMeta_(sheet, META.STATUS));
  const lastError = str_(readMeta_(sheet, META.ERROR));

  // Locate the Field/Extracted/Approved grid by its header.
  const values = sheet.getDataRange().getValues();
  let h = -1;
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim() === GRID_HEADER[0] &&
      String(values[r][1]).trim() === GRID_HEADER[1]) { h = r; break; }
  }
  const approvedFields = {};
  const extractedFields = {};
  if (h !== -1) {
    for (let r = h + 1; r < values.length; r++) {
      const label = String(values[r][0]).trim();
      if (!label || sameLabel_(label, META.SOURCES)) break;   // grid ends
      extractedFields[label] = values[r][1];
      approvedFields[label] = values[r][2];
    }
  }
  return {
    approved: approved, correlationId: corr, fileId: fileId, fileName: fileName,
    cancelled: cancelled,
    model: model, extractedAt: extAt, status: status, lastError: lastError,
    fields: approvedFields, extracted: extractedFields
  };
}
/**
 * What processApprovals does with a pending sheet.
 */
function nextAction_(approval) {
  if (approval.cancelled) return 'cancel';
  if (approval.approved) return 'push';
  return 'wait';
}
/**
 * Find a metadata value by its label in column A (first 30 rows).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} label
 * @return {*} The adjacent column-B value, or '' if not found.
 * @private
 */
function readMeta_(sheet, label) {
  const col = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 30), 2).getValues();
  for (let i = 0; i < col.length; i++) {
    if (sameLabel_(col[i][0], label)) return col[i][1];
  }
  return '';
}
/**
 * Label equality for the review sheet: trimmed and case-insensitive, so sheets created before the labels were
 * sentence-cased ("Source File ID") still read under the current constants ("Source file ID").
 * @param {*} a
 * @param {*} b
 * @return {boolean}
 * @private
 */
function sameLabel_(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}
/**
 * Mark a review sheet as pushed (status + timestamp).
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @private
 */
function markPushed_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Pushed');
  setMeta_(sheet, META.PUSHED_AT, new Date().toISOString());
}
function markCancelled_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Cancelled');
  setMeta_(sheet, META.CANCELLED_AT, new Date().toISOString());
}
/**
 * A sheet un-cancelled and moved back to Pending gets its Status word back.
 */
function markPending_(ss) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Pending Review');
}
/**
 * Mark a review sheet as errored (status + truncated message).
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} msg
 * @private
 */
function markError_(ss, msg) {
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.STATUS, 'Error');
  setMeta_(sheet, META.ERROR, String(msg).slice(0, 500));
}
/**
 * Set (or append) a metadata key/value pair in the A/B columns.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} label
 * @param {*} value
 * @private
 */
function setMeta_(sheet, label, value) {
  const last = Math.min(sheet.getLastRow(), 30);
  const col = sheet.getRange(1, 1, last, 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (sameLabel_(col[i][0], label)) { sheet.getRange(i + 1, 2).setValue(value); return; }
  }
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1).setValue(label).setFontWeight('bold');
  sheet.getRange(row, 2).setValue(value);
}


// --- BUILD ----------------------------------------------------------------------------------
/**
 * Build the Workato payload. `fields` is the approved truth; `provenance.extracted`
 * is the pre-review snapshot, so the correction delta stays auditable downstream.
 * @param {Approval} approval
 * @param {Config} cfg Unused today; kept for forward-compatible payload shaping.
 * @return {Object}
 * @private
 */
function buildPayload_(approval, cfg) {
  return {
    correlation_id: approval.correlationId,
    source: {
      file_id: approval.fileId,
      file_name: approval.fileName,
      drive_url: driveUrl_(approval.fileId)
    },
    extracted_at: approval.extractedAt,
    model: approval.model,
    fields: snakeKeys_(approval.fields),                      // <- pushed to Salesforce
    provenance: { extracted: snakeKeys_(approval.extracted) } // <- original, for audit
  };
}

// --- CONFIGURATION -------------------------------------------------------------------------
/**
 * The active config spreadsheet. Uses Script Property CONFIG_SHEET_ID when set,
 * otherwise the bound spreadsheet. Independent of {@link readConfig_} so it works
 * even while diagnosing a config failure.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @private
 */
function getConfigSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
/**
 * Read the Config tab into a typed object. Thin: reads the cells, then hands them to {@link parseConfig_}.
 * @return {Config}
 * @throws {Error} If the Config sheet or a required key is missing.
 * @private
 */
function readConfig_() {
  return parseConfig_(readConfigRaw_(getConfigSheet_()).raw);
}
/**
 * The Config tab of the active config spreadsheet.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} If the tab is missing.
 * @private
 */
function getConfigSheet_() {
  const sheet = getConfigSpreadsheet_().getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + CONFIG_SHEET_NAME + '" sheet.');
  return sheet;
}
/**
 * Column A/B of the Config tab as a key -> raw cell value map, plus the keys in sheet order (for stable hashing and
 * for preserving rows this script does not know about). Blank keys are skipped; a duplicated key keeps the last row,
 * as it always has.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {{raw:Object.<string,*>, order:string[]}}
 * @private
 */
function readConfigRaw_(sheet) {
  const raw = {};
  const order = [];
  sheet.getDataRange().getValues().forEach(function (r) {
    const k = String(r[0] || '').trim();
    if (!k) return;
    if (!(k in raw)) order.push(k);
    raw[k] = r[1];
  });
  return { raw: raw, order: order };
}
/**
 * Turn raw Config cell values into a typed object. PURE: the same function validates a proposed config from the
 * dashboard's Settings drawer before anything is written, so the form and the pollers can never disagree about
 * what is acceptable. Returns EVERY key this flow uses — no fixed whitelist that silently drops folder/webhook
 * keys — and validates the genuinely required ones.
 * @param {Object.<string,*>} raw Key -> cell value, as read by {@link readConfigRaw_}.
 * @return {Config}
 * @throws {Error} If a required key is missing or output_fields collide.
 * @private
 */
function parseConfig_(raw) {
  raw = raw || {};
  const cfg = {
    folder_id_ingestion: str_(raw.folder_id_ingestion),
    folder_id_processed: str_(raw.folder_id_processed),
    folder_id_failed: str_(raw.folder_id_failed),
    folder_id_pending: str_(raw.folder_id_pending),
    folder_id_pushed: str_(raw.folder_id_pushed),
    folder_id_cancelled: str_(raw.folder_id_cancelled),

    prompt_template: String(raw.prompt_template || ''),
    output_fields: parseList_(raw.output_fields),
    system_instruction: str_(raw.system_instruction),

    project_id: str_(raw.project_id),
    location: str_(raw.location) || 'global',
    model: str_(raw.model),
    temperature: isFilled_(raw.temperature) ? Number(raw.temperature) : undefined,
    max_tokens: isFilled_(raw.max_tokens) ? Number(raw.max_tokens) : undefined,
    grounding: isFilled_(raw.grounding) ? asBool_(raw.grounding) : false,
    grounding_debug: isFilled_(raw.grounding_debug) ? asBool_(raw.grounding_debug) : false,

    workato_webhook_url: str_(raw.workato_webhook_url),
    workato_shared_secret: str_(raw.workato_shared_secret),
    chat_webhook_url: str_(raw.chat_webhook_url),

    upload_allowed_emails: parseList_(raw.upload_allowed_emails).map(function (e) { return e.toLowerCase(); }),
    config_allowed_emails: parseList_(raw.config_allowed_emails).map(function (e) { return e.toLowerCase(); }),

    picker_url: str_(raw.picker_url),
    guide_url: str_(raw.guide_url),

    support_contact: str_(raw.support_contact)
  };

  const required = [
    'folder_id_ingestion',
    'folder_id_processed',
    'folder_id_failed',
    'folder_id_pending',
    'folder_id_pushed',
    'folder_id_cancelled',
    'prompt_template',
    'project_id',
    'workato_webhook_url'
  ];
  required.forEach(function (k) { if (!cfg[k]) throw new Error('Config missing required key: ' + k); });
  if (!cfg.output_fields.length) throw new Error('Config missing required key: output_fields');

  const seen = {};
  cfg.output_fields.forEach(function (f) {
    const k = toSnake_(f);
    if (seen[k]) {
      throw new Error('output_fields collide on API key "' + k + '": "' + seen[k] + '" and "' + f + '"');
    }
    seen[k] = f;
  });

  return cfg;
}
/**
 * Trim and stringify a cell value; null/undefined → ''.
 * @param {*} v
 * @return {string}
 * @private
 */
function str_(v) { return v == null ? '' : String(v).trim(); }
/**
 * Whether a cell value is present (note: 0 counts as filled).
 * @param {*} v
 * @return {boolean}
 * @private
 */
function isFilled_(v) { return v !== '' && v != null; }
/**
 * Coerce a cell value to boolean ('true'/'yes'/'1' → true).
 * @param {*} v
 * @return {boolean}
 * @private
 */
function asBool_(v) {
  if (typeof v === 'boolean') return v;
  return ['true', 'yes', '1'].indexOf(String(v).trim().toLowerCase()) !== -1;
}
/**
 * Split a single config cell into a trimmed list on commas/newlines.
 * @param {*} v
 * @return {string[]}
 * @private
 */
function parseList_(v) {
  if (!isFilled_(v)) return [];
  return String(v).split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}


// --- CHAT ----------------------------------------------------------------------------------
/**
 * Google Chat webhook notifier. Always sends a JSON object, never a bare string.
 * @class
 */
class ChatNotifier {
  /** @param {string} webhookUrl Incoming webhook url; falsy disables sending. */
  constructor(webhookUrl) { this.url = webhookUrl; }
  /**
   * POST a Chat message object (e.g. {text} or {cardsV2}).
   * @param {Object} message
   * @return {void}
   */
  send(message) {
    if (!this.url) { Logger.log('chat_webhook_url not set'); return; }
    const res = UrlFetchApp.fetch(this.url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(message), muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 400) Logger.log('Chat error: ' + res.getContentText());
  }
  /**
   * Convenience for a plain-text Chat message.
   * @param {string} s
   * @return {void}
   */
  text(s) { this.send({ text: s }); }
}

/**
 * Send a cardsV2 notification with a button that opens the review sheet.
 * @param {ChatNotifier} notifier
 * @param {string} sheetUrl
 * @param {string} fileName
 * @private
 */
function notifyReview_(notifier, sheetUrl, fileName) {
  notifier.send({
    cardsV2: [{
      cardId: 'contractReview',
      card: {
        header: { title: 'Contract staged for review', subtitle: fileName },
        sections: [{
          widgets: [
            { textParagraph: { text: 'Open the sheet, correct the <b>Approved</b> column, then check the <b>Approved</b> box.' } },
            { buttonList: { buttons: [{ text: 'Open review sheet', onClick: { openLink: { url: sheetUrl } } }] } }
          ]
        }]
      }
    }]
  });
}


// --- DRIVE HELPER ---------------------------------------------------------------------------
/**
 * Move a file to a folder.
 * @param {GoogleAppsScript.Drive.File} file
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @private
 */
function moveFile_(file, folder) { file.moveTo(folder); }

/**
 * Canonical Drive viewer link for the file ID.
 */
function driveUrl_(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}


// --- SETUP ---------------------------------------------------------------------------------
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
}
/**
 * Validate config without processing anything; logs the parsed field list.
 * @return {Config}
 */
function validateConfig() {
  const cfg = readConfig_();
  Logger.log('Config OK. Fields: ' + cfg.output_fields.join(', '));
  return cfg;
}
