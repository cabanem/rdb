/**
 * @file Code.gs — DrivePicker library, v2
 * @summary Let a visitor to an Apps Script web app pick files from THEIR Drive and hand the host the bytes.
 *
 * This ONE project plays two roles:
 *   • a LIBRARY the host references (clientHtml, fetchPicked), and
 *   • a tiny WEB APP of its own — the "picker helper" — deployed "Execute as: User accessing", access Domain.
 *
 * WHY A HELPER WEB APP
 *   Google will not accept a *.googleusercontent.com origin on an OAuth client ("invalid origin"), and every
 *   HtmlService page lives on one, so Google Identity Services cannot mint a token in the browser for an Apps
 *   Script page. The supported route is ScriptApp.getOAuthToken() — server-side, and belonging to whoever the
 *   script EXECUTES AS. The host dashboard must keep executing as its owner (so visitors need no access to its
 *   sheets and folders), so the picker runs in a separate web app that executes as the visitor. The dashboard
 *   embeds that helper in an iframe; the helper opens the Picker with the visitor's token and posts the picks
 *   (and the token) back up the frame chain; the dashboard then calls its own server, which uses the token via
 *   fetchPicked() to download the file. The visitor authorises the helper once, for drive.file only.
 *   "Up the frame chain" means: to every ancestor window, with targetOrigin = the allow-listed host origin, so
 *   only the host can receive it (see Picker.html for why the depth must not be assumed).
 *
 * PUBLIC SURFACE (anything ending in `_` is private)
 *   VERSION              var, so it crosses the library boundary (const/let do not)
 *   clientHtml()         -> string  <script> defining window.DrivePicker.mount() for the HOST page
 *   fetchPicked(pick, token, opts) -> Blob  download (or export) one picked file with the visitor's token
 *   doGet(e)             the helper web app (this project's own deployment, not called by hosts)
 *
 * SCRIPT PROPERTIES (this project — Project Settings > Script properties)
 *   PICKER_API_KEY          API key restricted to the Google Picker API (any project with the Picker API enabled)
 *   PICKER_APP_ID           OPTIONAL. Project NUMBER of the Cloud project that issues this script's tokens. Leave it
 *                           unset and the helper derives it from the token itself (see appIdFromToken_), which is
 *                           correct whether the script uses its default Cloud project or a standard one.
 *   PICKER_ALLOWED_ORIGINS  comma/newline list of host page origins allowed to embed the helper and receive
 *                           tokens, e.g. https://n-abc…-0lu-script.googleusercontent.com. The helper refuses
 *                           any other origin and says which string to add. This replaces the OAuth client's
 *                           "Authorized JavaScript origins" that Google would not let us register.
 *
 * ONE-TIME SETUP: see README §3–§4.
 */

/** @type {string} Library version. `var` on purpose: const/let are not visible to consuming projects. */
var VERSION = '2.2.0';

/** @type {string} Drive v3 files endpoint. */
var DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files/';

/** @type {string} Prefix shared by every native Google type (Docs, Sheets, Slides, Forms, ...). */
var GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/** Native types that can be exported, and the format used when the host does not choose one. */
var DEFAULT_EXPORT = {
  'application/vnd.google-apps.document':     'application/pdf',
  'application/vnd.google-apps.spreadsheet':  'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing':      'application/pdf'
};

/** Export MIME -> file extension appended to the exported name. */
var EXPORT_EXT = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv'
};

/** Script Property names. */
var PROP_API_KEY = 'PICKER_API_KEY';
var PROP_APP_ID = 'PICKER_APP_ID';
var PROP_ALLOWED = 'PICKER_ALLOWED_ORIGINS';

// --- PUBLIC: for hosts -------------------------------------------------------------------------

/**
 * The host-side embed: a <script> block defining window.DrivePicker.mount(opts). Inline it in the host's
 * HtmlService TEMPLATE with <?!= DrivePicker.clientHtml() ?>.
 * @return {string}
 */
function clientHtml() {
  return HtmlService.createHtmlOutputFromFile('Client').getContent().replace(/\{\{VERSION\}\}/g, VERSION);
}

/**
 * Download one picked file with the visitor's token and return it as a named Blob. Native Google files are
 * exported (PDF by default, or opts.exportMime). Throws plain-language errors the host can show verbatim.
 * @param {{id:string, name:string, mimeType:string}} pick
 * @param {string} token The visitor's access token, as delivered to the host's onPicked.
 * @param {{exportMime:(string|undefined)}} [opts]
 * @return {GoogleAppsScript.Base.Blob}
 */
function fetchPicked(pick, token, opts) {
  opts = opts || {};
  var plan = downloadPlan_(pick, opts.exportMime);
  if (!token) throw new Error('No access token was supplied for the Drive download.');

  var resp = UrlFetchApp.fetch(plan.url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error(describeDriveError_(code, resp.getContentText(), plan.name));

  var blob = resp.getBlob().setName(plan.name);
  if (plan.mimeType) blob.setContentType(plan.mimeType);
  return blob;
}

// --- THE HELPER WEB APP (this project's own deployment) ---------------------------------------

/**
 * Serve the picker page to the visitor. Executes as the visitor, so ScriptApp.getOAuthToken() is THEIR token.
 * Query parameters (set by the host embed): o = host page origin, n = nonce, mime = comma list, standalone = 1
 * when opened in its own tab for the one-time authorisation.
 * @param {GoogleAppsScript.Events.DoGet} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var props = PropertiesService.getScriptProperties();
  var origin = String(p.o || '').trim();
  var allowed = parseList_(props.getProperty(PROP_ALLOWED));

  var cfg = {
    apiKey: props.getProperty(PROP_API_KEY) || '',
    appId: props.getProperty(PROP_APP_ID) || '',      // may be filled from the token below
    target: origin,
    nonce: String(p.n || ''),
    mimeTypes: String(p.mime || ''),
    // A visit with no host origin at all (someone opened the /exec URL directly, or Google's authorisation
    // redirect dropped the query string) is treated as the standalone confirmation page, not as a refused host.
    standalone: String(p.standalone || '') === '1' || !origin,
    token: '',
    error: ''
  };

  if (!cfg.apiKey) {
    cfg.error = 'The picker helper is not configured: set Script Property ' + PROP_API_KEY + '.';
  } else if (!cfg.standalone && !originAllowed_(origin, allowed)) {
    cfg.error = 'This host is not allowed to use the picker. Add its origin to Script Property ' + PROP_ALLOWED +
      ' of the DrivePicker project: ' + (origin || '(no origin was passed)');
  } else {
    cfg.token = ScriptApp.getOAuthToken();      // the visitor's; only embedded in a page served to that visitor
    if (!cfg.appId) {
      cfg.appId = appIdFromToken_(cfg.token);
      if (!cfg.appId) {
        cfg.error = 'Could not determine this script\u2019s Cloud project number from its token; set Script Property ' + PROP_APP_ID + '.';
        cfg.token = '';                           // never embed a token in an error page
      }
    }
  }

  var t = HtmlService.createTemplateFromFile('Picker');
  t.cfgJson = JSON.stringify(cfg).replace(/<\//g, '<\\/');
  return t.evaluate()
    .setTitle('Choose from Drive')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)     // hosts embed this page; the allow-list guards it
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * The project NUMBER of the Cloud project that issued a token — which is exactly what the Picker's setAppId()
 * needs for drive.file grants to attach. Works for the script's hidden default project too, which is what lets
 * us skip "Change project" in Project Settings when org policy blocks it. Cached per script for 6 hours.
 * @param {string} token An access token minted by this script (ScriptApp.getOAuthToken()).
 * @return {string} Digits, or '' if it could not be determined.
 * @private
 */
function appIdFromToken_(token) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('appId');
  if (hit) return hit;
  try {
    var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return '';
    var info = JSON.parse(resp.getContentText());
    var n = projectNumberFromClientId_(info.aud || info.azp || info.issued_to);
    if (n) cache.put('appId', n, 21600);
    return n;
  } catch (e) {
    return '';
  }
}

/**
 * Run once from the editor to see what the helper will use as appId, and to prove the Drive API is reachable
 * from this script's Cloud project. Logs both.
 * @return {void}
 */
function probeSetup() {
  var token = ScriptApp.getOAuthToken();
  Logger.log('appId (project number) from token: ' + (appIdFromToken_(token) || '(unknown)'));
  var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  Logger.log('Drive API from this project -> HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 160));
  Logger.log(PROP_API_KEY + ' set: ' + !!PropertiesService.getScriptProperties().getProperty(PROP_API_KEY));
}

// --- PURE HELPERS (unit-tested in Tests.gs) -------------------------------------------------------

/**
 * OAuth client IDs are "<projectNumber>-<hash>.apps.googleusercontent.com"; return the number, or '' if the
 * string is not in that shape. Pure.
 * @param {*} clientId
 * @return {string}
 * @private
 */
function projectNumberFromClientId_(clientId) {
  var m = /^(\d{6,})-[a-z0-9]+\.apps\.googleusercontent\.com$/i.exec(String(clientId || '').trim());
  return m ? m[1] : '';
}

/**
 * Exact-match a host origin against the allow-list (trimmed, case-insensitive on host, no trailing slash).
 * @param {string} origin e.g. https://n-abc-0lu-script.googleusercontent.com
 * @param {string[]} allowed
 * @return {boolean}
 * @private
 */
function originAllowed_(origin, allowed) {
  var o = normalizeOrigin_(origin);
  if (!o) return false;
  for (var i = 0; i < (allowed || []).length; i++) {
    if (normalizeOrigin_(allowed[i]) === o) return true;
  }
  return false;
}

/**
 * Lower-case, trimmed, scheme+host(+port) only; '' if not an https origin.
 * @param {string} s
 * @return {string}
 * @private
 */
function normalizeOrigin_(s) {
  var m = /^\s*(https:\/\/[a-z0-9.-]+(?::\d+)?)\/?\s*$/i.exec(String(s || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Split a comma/newline list into trimmed non-empty entries.
 * @param {*} v
 * @return {string[]}
 * @private
 */
function parseList_(v) {
  if (v == null || v === '') return [];
  return String(v).split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

/**
 * Decide how a pick is fetched: media download for real files, export for native Google files.
 * @param {{id:string, name:string, mimeType:string}} pick
 * @param {string} [exportMime]
 * @return {{url:string, name:string, mimeType:?string, exported:boolean}}
 * @private
 */
function downloadPlan_(pick, exportMime) {
  if (!pick || !pick.id) throw new Error('Nothing was picked.');
  var id = String(pick.id);
  var mime = String(pick.mimeType || '');
  var name = String(pick.name || id).trim() || id;

  if (isGoogleNative_(mime)) {
    var target = exportMime || DEFAULT_EXPORT[mime];
    if (!target) {
      throw new Error('"' + name + '" is a Google ' + mime.slice(GOOGLE_NATIVE_PREFIX.length) + ' and cannot be downloaded or exported.');
    }
    return {
      url: DRIVE_FILES_API + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(target),
      name: withExt_(name, EXPORT_EXT[target]),
      mimeType: target,
      exported: true
    };
  }
  return {
    url: DRIVE_FILES_API + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true',
    name: name,
    mimeType: mime || null,
    exported: false
  };
}

/** @private */
function isGoogleNative_(mime) { return String(mime || '').indexOf(GOOGLE_NATIVE_PREFIX) === 0; }

/** @private */
function withExt_(name, ext) {
  if (!ext) return name;
  return name.toLowerCase().slice(-(ext.length + 1)) === '.' + ext.toLowerCase() ? name : name + '.' + ext;
}

/**
 * Turn a Drive API failure into a sentence a person can act on.
 * @private
 */
function describeDriveError_(code, body, name) {
  var reason = '';
  try {
    var j = JSON.parse(body);
    reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || (j.error && j.error.message) || '';
  } catch (e) { /* not JSON */ }

  if (code === 401) return 'Drive rejected the sign-in token (expired or revoked). Click Add from Drive again to sign in afresh.';
  if (code === 403) {
    if (/rateLimit|quota/i.test(reason)) return 'Drive is rate-limiting requests right now. Try again in a minute.';
    if (/has not been used in project|is disabled|accessNotConfigured/i.test(reason + body)) {
      return 'The Google Drive API is not enabled in the picker’s Cloud project. ' + reason;
    }
    return 'Drive refused access to "' + name + '". With the drive.file scope the app can only read files chosen through ' +
      'the picker in this session; pick it again to grant access.' + (reason ? ' (' + reason + ')' : '');
  }
  if (code === 404) return '"' + name + '" was not found in Drive, or is not shared with you.';
  return 'Drive returned ' + code + (reason ? ': ' + reason : '') + ' for "' + name + '".';
}
