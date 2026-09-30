/**
 * @file WebApp.gs
 * @summary The home base: doGet() serves Dashboard.html; getDashboardData() hands it one JSON snapshot built from the
 * `_queue` tab (what is in pending right now, plus heartbeats) and the tail of `_logs` (what happened today, errors over
 * the last two days).
 *
 * @description Design notes:
 *   1. The page is a PROJECTION. Nothing here writes anything. "Right now" comes from `_queue`, which processApprovals()
 *      rewrites every run; "today" and "errors" are computed from `_logs` rows on each request. Two sources of truth,
 *      each rendered by the code that naturally owns it; the dashboard keeps no state of its own.
 *   2. The page never opens a review sheet. Reading the pending folder live would cost one openById per sheet per page
 *      load; the poller already paid that cost and left the answer in `_queue`.
 *   3. Everything crossing to the browser is a primitive: google.script.run cannot return Date objects, so every
 *      timestamp is an ISO string (see toIso_ in Snapshot.gs). The browser renders them in the viewer's local time.
 *   4. summarizeLogs_() is pure so the counting/windowing logic is unit-tested in Tests.gs without a spreadsheet.
 *
 * DEPLOY (once)
 *   1. clasp push (Dashboard.html rides along; .clasp.json already lists .html).
 *   2. Editor: Deploy > New deployment > type "Web app" > Execute as: Me > Who has access: Anyone within <your org>
 *      > Deploy. Copy the Web app URL. (appsscript.json's "webapp" block pre-fills those two choices.)
 *      Or: clasp deploy --description "dashboard", then Deploy > Manage deployments for the URL.
 *   3. Run processApprovals() once by hand (or wait one poll) so `_queue` exists and has a heartbeat.
 *   4. Share the URL; pinning it in the Chat space works well.
 *
 * UPDATE (after editing Dashboard.html or this file)
 *   Deploy > Manage deployments > pencil > Version: "New version" > Deploy. The URL does not change.
 *   Or: clasp deploy -i <deploymentId>. Trigger/poller code changes need only clasp push, not a new deployment.
 *
 * "Execute as: Me" means page loads run as the deployer against the Config spreadsheet, so viewers need the URL and
 * an org login, not access to the spreadsheet. Each load is one short execution on the deployer's quota.
 */

/** @const {number} How many `_logs` rows to read from the tail. ~60 rows/day at current volume; this is weeks. */
const DASHBOARD_LOG_TAIL = 3000;
/** @const {number} Errors window shown on the dashboard, in days. */
const DASHBOARD_ERROR_DAYS = 2;
/** @const {number} Cap on rows returned in each list, so a bad day cannot make the page huge. */
const DASHBOARD_LIST_CAP = 100;

/**
 * Web app entry point. Dashboard.html is a TEMPLATE (not a static file) so the DrivePicker script can be included
 * only when configured — `<?!= DrivePicker.clientHtml() ?>` is evaluated here, server-side. Served as a static file,
 * the scriptlets would be emitted as text and silently ignored by the browser.
 * @param {GoogleAppsScript.Events.DoGet} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  let cfg = null;
  try { cfg = readConfig_(); } catch (err) { /* a config problem must not take the page down */ }

  const t = HtmlService.createTemplateFromFile('Dashboard');
  t.picker = !!(cfg && pickerConfig_(cfg));
  // The guide link is decided at page load, like the picker: it is static, and must show even when the data
  // call later fails. Only an https URL is emitted; <?= ?> in the template HTML-escapes it.
  t.guideUrl = (cfg && /^https:\/\/\S+$/.test(cfg.guide_url || '')) ? cfg.guide_url : '';
  return t.evaluate()
    .setTitle('Contract Intake')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Picker settings for the page, or null when Config has no picker_url. Presence is the switch. The API key and
 * project number live in the DrivePicker project's Script Properties, so hosts carry only the helper's URL.
 * @param {Config} cfg
 * @return {?{url:string, mimeTypes:string[]}}
 * @private
 */
function pickerConfig_(cfg) {
  if (!cfg.picker_url) return null;
  return { url: cfg.picker_url, mimeTypes: PICKER_MIME_TYPES };
}

/**
 * One snapshot for the page, called from the browser via google.script.run.
 *
 * Every data source is read inside its own try/catch. A resource the running account cannot open becomes an entry
 * in `access.problems` and the page renders what it can, instead of one raw exception replacing the whole page.
 * `access.viewer` / `access.runsAs` let the page say precisely whose permissions are in play: they differ under
 * "Execute as: Me" (the visitor is viewer, the deployer is runsAs) and coincide under "Execute as: User accessing".
 *
 * @return {{
 *   generatedAt:string, pollMinutes:number, maxUploadBytes:number, intakeWaiting:?number,
 *   intake:{picker:?Object, folderUrl:string},
 *   access:{viewer:string, runsAs:string, contact:string, problems:Array<{what:string, kind:string, message:string}>},
 *   heartbeats:{ingestion:?string, approvals:?string},
 *   queue:Array<Object>,
 *   today:{staged:number, pushed:number, errors:number},
 *   errors:Array<Object>, activity:Array<Object>
 * }}
 */
function getDashboardData() {
  const now = new Date();
  const access = { viewer: emailOf_(function () { return Session.getActiveUser(); }),
                   runsAs: emailOf_(function () { return Session.getEffectiveUser(); }),
                   contact: '', problems: [] };
  const attempt = function (what, fn, fallback) {
    try { return fn(); }
    catch (err) { access.problems.push({ what: what, kind: classifyError_(err && err.message), message: String((err && err.message) || err) }); return fallback; }
  };

  const cfg = attempt('the configuration sheet', function () { return readConfig_(); }, null);
  if (cfg) access.contact = cfg.support_contact || '';

  const queueSheet = attempt('the queue', function () { return getQueueSheet_(); }, null);
  const logRows = attempt('the activity log', function () { return readRecentLogRows_(DASHBOARD_LOG_TAIL); }, []);
  const folderUrl = cfg ? attempt('the Intake folder', function () { return DriveApp.getFolderById(cfg.folder_id_ingestion).getUrl(); }, '') : '';
  const summary = summarizeLogs_(logRows, now, DASHBOARD_ERROR_DAYS, DASHBOARD_LIST_CAP);

  return {
    generatedAt: now.toISOString(),
    pollMinutes: POLL_MINUTES,
    maxUploadBytes: INLINE_PDF_MAX_BYTES,        // the drop zone enforces the same cap as extraction
    intakeWaiting: cfg ? countIntakeFiles_() : null,
    intake: {
      picker: cfg ? pickerConfig_(cfg) : null,
      folderUrl: folderUrl
    },
    access: access,
    heartbeats: queueSheet ? readHeartbeats_(queueSheet) : { ingestion: null, approvals: null },
    queue: queueSheet ? readQueueRows_(queueSheet) : [],
    today: summary.today,
    errors: summary.errors,
    activity: summary.activity
  };
}

/**
 * Email from a Session getter, lower-cased; '' if the platform withholds it. Never throws.
 * @param {function():GoogleAppsScript.Base.User} getter
 * @return {string}
 * @private
 */
function emailOf_(getter) {
  try { return String(getter().getEmail() || '').trim().toLowerCase(); } catch (e) { return ''; }
}

/**
 * Sort an Apps Script error message into a bucket the page can phrase for a person. Pure.
 * @param {string} message
 * @return {'permission'|'authorization'|'missing'|'transient'|'other'}
 * @private
 */
function classifyError_(message) {
  const m = String(message || '');
  if (/authorization is required|not authorized|re-?authoriz/i.test(m)) return 'authorization';
  if (/permission|not have access|access denied|PERMISSION_DENIED|forbidden|403/i.test(m)) return 'permission';
  if (/not found|does not exist|missing "|missing required key|no item with the given id|unable to open|openById/i.test(m)) return 'missing';
  if (/server error|service invoked too many times|timed? ?out|try again|temporarily|429|50\d/i.test(m)) return 'transient';
  return 'other';
}

/**
 * The last `n` data rows of `_logs` (header excluded), oldest first, as raw cell values.
 * @param {number} n
 * @return {Array<Array<*>>} Rows in LOG_HEADERS order: [Timestamp, Level, Context, Correlation ID, Message, Details].
 * @private
 */
function readRecentLogRows_(n) {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  return sheet.getRange(start, 1, last - start + 1, LOG_HEADERS.length).getValues();
}

/**
 * Turn raw `_logs` rows into today's counts, the recent-errors list, and today's activity list. Pure.
 *
 * "Today" is the calendar day of `now` in the script's time zone (Apps Script's Date honours appsscript.json's
 * timeZone). Rows whose timestamp is not a usable date are skipped rather than crashing the page.
 *
 * @param {Array<Array<*>>} rows      Raw rows, [ts, level, ctx, corr, msg, details].
 * @param {Date} now                  Reference time.
 * @param {number} errorDays          Window for the errors list.
 * @param {number} [cap]              Max entries per list (default 100).
 * @return {{today:{staged:number,pushed:number,errors:number}, errors:Array<Object>, activity:Array<Object>}}
 *         Lists are newest first.
 * @private
 */
function summarizeLogs_(rows, now, errorDays, cap) {
  cap = cap || 100;
  const startOfToday = new Date(now.getTime());
  startOfToday.setHours(0, 0, 0, 0);
  const errorsSince = now.getTime() - errorDays * 86400000;

  const today = { staged: 0, pushed: 0, errors: 0 };
  const errors = [];
  const activity = [];

  (rows || []).forEach(function (r) {
    const d = (r[0] instanceof Date) ? r[0] : new Date(r[0]);
    if (isNaN(d.getTime())) return;
    const entry = {
      ts: d.toISOString(),
      level: String(r[1] || ''),
      context: String(r[2] || ''),
      correlationId: String(r[3] || ''),
      message: String(r[4] || ''),
      details: String(r[5] || '')
    };
    const isError = entry.level === 'ERROR';

    if (d.getTime() >= startOfToday.getTime()) {
      if (isError) today.errors++;
      else if (entry.message.indexOf('Staged ') === 0) today.staged++;
      else if (entry.message.indexOf('Pushed ') === 0) today.pushed++;
      activity.push(entry);
    }
    if (isError && d.getTime() >= errorsSince) errors.push(entry);
  });

  const newestFirst = function (a, b) { return a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0); };
  errors.sort(newestFirst);
  activity.sort(newestFirst);
  return { today: today, errors: errors.slice(0, cap), activity: activity.slice(0, cap) };
}

function debugPicker() {
  Logger.log(JSON.stringify(pickerConfig_(readConfig_())));
  Logger.log(DrivePicker.VERSION + ' | mount takes url: ' + (DrivePicker.clientHtml().indexOf('url,') !== -1));
}
