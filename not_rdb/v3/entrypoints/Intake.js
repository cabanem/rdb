/**
 * @file entrypoints/Intake.gs — every way a contract can enter the pipeline from the dashboard. Replaces Upload.gs.
 *
 * @summary One landing, many adapters. Each source (local drop, Drive picker, ...) is a thin adapter that turns
 * its input into a Blob and calls stageBlob_(), which creates the file in the Intake folder and records where it
 * came from. From there the file is indistinguishable from one dropped into the folder in Drive: same poller,
 * same review sheet, same Chat card, same log.
 *
 * ADAPTERS (called from the page via google.script.run — these MUST live in this project, not a library)
 *   uploadContract(file)   local drop: {name, size, base64}                     -> stageBlob_
 *   importPicked(p)        DrivePicker library: {pick:{id,name,mimeType}, token}  -> DrivePicker.fetchPicked -> stageBlob_
 *
 * LANDING
 *   stageBlob_(blob, prov)     size check, create in Intake, then recordIntake_
 *   recordIntake_(file, prov)  Drive description + one log row (context 'intake'), returns {name, url}
 *
 * The log context is always 'intake' so the dashboard can label the link "Open file" without knowing the source.
 *
 * Identity: the web app executes as the deployer, so files are created as the deployer; the visitor's email comes
 * from Session.getActiveUser() (same Workspace domain; needs the userinfo.email scope) and rides in the log and the
 * file description. Access: Config key upload_allowed_emails (comma/newline list) restricts who may submit; empty
 * means anyone who can open the dashboard.
 */

/** @typedef {{source:string, who:string, from:string}} Provenance  source: 'upload' | 'picker'; from: a URL or ''. */
/** @const {Object.<string,string>} Accepted extensions -> Drive MIME type, for local uploads. */
const UPLOAD_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword'
};
/** @const {string[]} MIME types the Drive picker offers. Native Docs are exported to PDF by the library. */
const PICKER_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.google-apps.document'
];
/**
 * Local drop / file chooser. The browser sends the file as base64.
 * @param {{name:string, size:number, base64:string}} file
 * @return {{name:string, url:string}}
 * @throws {Error} Plain-language reason, shown verbatim on the page.
 */
function uploadContract(file) {
  const cfg = readConfig_();
  const who = uploaderEmail_();
  assertUploadAllowed_(who, cfg.upload_allowed_emails);

  const v = validateUpload_(file, INLINE_PDF_MAX_BYTES);
  if (!v.ok) throw new Error(v.reason);

  const blob = Utilities.newBlob(Utilities.base64Decode(file.base64), v.mimeType, v.name);
  return stageBlob_(blob, cfg, { source: 'upload', who: who, from: '' });
}
/**
 * Drive picker (DrivePicker library). The page passes the pick and the VISITOR's token; the library downloads
 * (or exports) the file with that token; we land it exactly like an upload.
 * @param {{pick:{id:string, name:string, mimeType:string}, token:string}} p
 * @return {{name:string, url:string}}
 * @throws {Error}
 */
function importPicked(p) {
  const cfg = readConfig_();
  const who = uploaderEmail_();
  assertUploadAllowed_(who, cfg.upload_allowed_emails);
  if (!p || !p.pick || !p.token) throw new Error('Nothing was picked.');

  const blob = DrivePicker.fetchPicked(p.pick, p.token);           // throws its own readable errors
  return stageBlob_(blob, cfg, { source: 'picker', who: who, from: driveUrl_(p.pick.id) });
}
/**
 * Create the blob as a file in the Intake folder and record its provenance.
 * @param {GoogleAppsScript.Base.Blob} blob Named, typed.
 * @param {Config} cfg
 * @param {Provenance} prov
 * @return {{name:string, url:string}}
 * @throws {Error} If the blob exceeds the extraction cap.
 * @private
 */
function stageBlob_(blob, cfg, prov) {
  const size = blob.getBytes().length;
  if (size > INLINE_PDF_MAX_BYTES) {
    throw new Error('"' + blob.getName() + '" is ' + mb_(size) + ' MB; the limit is ' + mb_(INLINE_PDF_MAX_BYTES) + ' MB.');
  }
  const created = DriveApp.getFolderById(cfg.folder_id_ingestion).createFile(blob);
  return recordIntake_(created, prov);
}
/**
 * Stamp provenance on the file and in the log. The log Details column stays a bare URL so the dashboard links it.
 * @param {GoogleAppsScript.Drive.File} file
 * @param {Provenance} prov
 * @return {{name:string, url:string}}
 * @private
 */
function recordIntake_(file, prov) {
  const desc = intakeDescription_(prov, new Date());
  file.setDescription(desc);
  logInfo_('intake', intakeMessage_(file.getName(), prov), '', file.getUrl());
  return { name: file.getName(), url: file.getUrl() };
}
/**
 * "Via dashboard upload by ann@corp.com at 2026-09-08T19:00:00.000Z" / "... from Drive picker ... (source: <url>)". Pure.
 * @param {Provenance} prov
 * @param {Date} when
 * @return {string}
 * @private
 */
function intakeDescription_(prov, when) {
  const via = prov.source === 'picker' ? 'Via dashboard (Drive picker)' : 'Via dashboard upload';
  return via + (prov.who ? ' by ' + prov.who : '') + ' at ' + when.toISOString() + (prov.from ? ' (source: ' + prov.from + ')' : '');
}
/**
 * Log message: "Uploaded <name> (who)" or "Imported <name> (who)". Pure.
 * @param {string} name
 * @param {Provenance} prov
 * @return {string}
 * @private
 */
function intakeMessage_(name, prov) {
  return (prov.source === 'picker' ? 'Imported ' : 'Uploaded ') + name + (prov.who ? ' (' + prov.who + ')' : '');
}
/**
 * Validate a local upload before touching Drive. MIME comes from the extension, not the browser.
 * @param {{name:string, size:number, base64:string}} file
 * @param {number} maxBytes
 * @return {{ok:true, name:string, mimeType:string}|{ok:false, reason:string}}
 * @private
 */
function validateUpload_(file, maxBytes) {
  if (!file || typeof file.base64 !== 'string' || !file.base64) return { ok: false, reason: 'No file content received.' };
  const raw = String(file.name || '').replace(/[\\/]/g, '_').trim();
  if (!raw) return { ok: false, reason: 'The file has no name.' };
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : '';
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const name = stem.slice(0, 180) + (ext ? '.' + ext : '');   // cap the stem, never the extension
  const mimeType = UPLOAD_TYPES[ext];
  if (!mimeType) {
    return { ok: false, reason: 'Only PDF and Word (.docx, .doc) files can be uploaded here. Use "Add from Drive" for a Google Doc.' };
  }
  if (Number(file.size) > maxBytes) {
    return { ok: false, reason: '"' + name + '" is ' + mb_(file.size) + ' MB; the limit is ' + mb_(maxBytes) + ' MB.' };
  }
  return { ok: true, name: name, mimeType: mimeType };
}
/**
 * @param {string} who Lower-cased visitor email ('' if unknown).
 * @param {string[]} allowed Lower-cased emails; empty = anyone who can open the page.
 * @throws {Error}
 * @private
 */
function assertUploadAllowed_(who, allowed) {
  if (!allowed || !allowed.length) return;
  if (!who || allowed.indexOf(who) === -1) {
    throw new Error('Your account is not on the upload list for this tool.' + (who ? ' (' + who + ')' : ''));
  }
}
/**
 * Visitor's email, lower-cased, or '' when withheld. Never throws.
 * @return {string}
 * @private
 */
function uploaderEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); }
  catch (e) { return ''; }
}
/**
 * Bytes -> MB with one decimal, trailing .0 dropped. Pure.
 * @param {number} bytes
 * @return {string}
 * @private
 */
function mb_(bytes) { return (Number(bytes) / 1048576).toFixed(1).replace(/\.0$/, ''); }
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
