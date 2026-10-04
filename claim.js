/**
 * @file Access.gs — makes folder access a checked precondition instead of a 5-minutes-later surprise.
 *
 * WHY
 *   The pipeline runs as ONE identity: whoever created the triggers (and deployed the web app). Every Drive call in
 *   the two loops — list Intake, move originals, create and move review sheets — is that identity's permission on
 *   that folder. DriveApp hides "does not exist" and "exists but you can't see it" behind one message ("No item
 *   with the given ID could be found, or you do not have permission..."), and a folder that opens fine can still
 *   refuse a create or a move. So: ask Drive what this identity CAN do on each configured folder, up front, and
 *   name the folder and the capability that is missing.
 *
 * INVARIANT (reported, not enforced, so an existing My Drive setup keeps running while you migrate)
 *   Every configured folder lives in a shared drive. In My Drive each item has a human owner and non-owner move
 *   semantics depend on that owner; in a shared drive the organisation owns the items and the capability model is
 *   clean. "Content manager" on the shared drive is exactly the permission the loops need.
 *
 * USES
 *   checkAccess() / checkAccessUi()  Manual or from the "Contract Intake" menu: one line per folder.
 *   assertFolderAccess_(cfg, keys)   Top of both loops: a bad config becomes one clear ERROR row in _logs.
 *   createInPlace_()                 Create a file directly inside a folder (shared-drive safe); no My Drive hop.
 *
 * Requires the Advanced Drive Service (v3), which appsscript.json already enables.
 */

/** @const {string[]} Config keys that name pipeline folders. */
const FOLDER_KEYS = [
  'folder_id_ingestion', 'folder_id_processed', 'folder_id_failed',
  'folder_id_pending', 'folder_id_pushed', 'folder_id_cancelled'
];

/** @const {Object.<string,string>} Capabilities every pipeline folder must grant the runner, in plain words. */
const REQUIRED_CAPS = {
  canListChildren: 'list the files in it',
  canAddChildren: 'create or move files into it'
};

/**
 * Inspect one folder as the running identity. Never throws: a folder that cannot be opened is reported, not raised.
 * @param {string} key Config key.
 * @param {string} id  Folder id (may be '').
 * @return {{key:string, id:string, name:string, owner:string, sharedDrive:boolean, ok:boolean, problems:string[], notes:string[]}}
 * @private
 */
function inspectFolder_(key, id) {
  const out = { key: key, id: id, name: '', owner: '', sharedDrive: false, ok: false, problems: [], notes: [] };
  if (!id) { out.problems.push('is not set'); return out; }

  let f;
  try {
    f = Drive.Files.get(id, {
      supportsAllDrives: true,
      fields: 'id,name,mimeType,driveId,trashed,owners(emailAddress),capabilities(canListChildren,canAddChildren)'
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    out.problems.push('cannot be opened by ' + runnerEmail_() + ' [' + classifyError_(msg) + ']: ' + msg);
    return out;
  }

  out.name = f.name || '';
  out.sharedDrive = !!f.driveId;
  out.owner = (((f.owners || [])[0] || {}).emailAddress || '').toLowerCase();
  // Ownership is informational: with Editor on a folder someone else owns, the loops still work (Claim.gs copies
  // what it cannot move). It becomes a dependency on that person's sharing, so say so, but do not fail the run.
  if (!out.sharedDrive && out.owner && out.owner !== runnerEmail_().toLowerCase()) {
    out.notes.push('owned by ' + out.owner + ' — the pipeline depends on their sharing staying at Editor');
  }
  if (f.mimeType !== MimeType.FOLDER) out.problems.push('is not a folder (' + f.mimeType + ')');
  if (f.trashed) out.problems.push('is in the trash');
  const caps = f.capabilities || {};
  Object.keys(REQUIRED_CAPS).forEach(function (c) {
    if (!caps[c]) out.problems.push('does not let ' + runnerEmail_() + ' ' + REQUIRED_CAPS[c] + ' (' + c + ')');
  });
  out.ok = out.problems.length === 0;
  return out;
}

/**
 * Inspect the configured folders.
 * @param {Config} cfg
 * @param {string[]=} keys Subset of FOLDER_KEYS; default all.
 * @return {Array<Object>} One inspectFolder_ result per key.
 * @private
 */
function checkFolderAccess_(cfg, keys) {
  return (keys || FOLDER_KEYS).map(function (k) { return inspectFolder_(k, cfg[k]); });
}

/**
 * Throw one readable error if any of the given folders is unusable by the running identity.
 * Six Drive reads per run is cheap; a trigger that fails with "folder_id_pending (Pending) does not let
 * bot@corp.com create or move files into it" is worth far more than the quota.
 * @param {Config} cfg
 * @param {string[]=} keys Subset of FOLDER_KEYS; default all.
 * @return {Array<Object>} The report, for callers that want it.
 * @throws {Error}
 * @private
 */
function assertFolderAccess_(cfg, keys) {
  const report = checkFolderAccess_(cfg, keys);
  const bad = report.filter(function (r) { return !r.ok; });
  if (bad.length) {
    throw new Error('Folder access check failed as ' + runnerEmail_() + ': ' +
      bad.map(function (r) { return r.key + ' (' + (r.name || r.id) + ') ' + r.problems.join('; '); }).join(' | '));
  }
  return report;
}

/**
 * Manual / menu entry: one line per folder plus the identity that was checked. Returns the text it logged.
 * @return {string}
 */
function checkAccess() {
  const cfg = readConfig_();
  const lines = checkFolderAccess_(cfg).map(function (r) {
    return (r.ok ? 'OK    ' : 'FAIL  ') + r.key + '  ' + (r.name || r.id || '(unset)') +
      (r.id ? (r.sharedDrive ? '  [shared drive]' : '  [My Drive — move to a shared drive]') : '') +
      (r.problems.length ? '\n        ' + r.problems.join('\n        ') : '') +
      (r.notes.length ? '\n        note: ' + r.notes.join('\n        note: ') : '');
  });
  const text = 'Checked as ' + runnerEmail_() + '\n' + lines.join('\n');
  Logger.log(text);
  return text;
}

/** Same as checkAccess(), shown in a dialog. Wire into onOpen(): .addItem('Check folder access', 'checkAccessUi'). */
function checkAccessUi() {
  const ui = SpreadsheetApp.getUi();
  ui.alert('Folder access', checkAccess(), ui.ButtonSet.OK);
}

/**
 * The identity whose permissions are in play (trigger owner / deployer). Never throws.
 * @return {string}
 * @private
 */
function runnerEmail_() {
  try { return Session.getEffectiveUser().getEmail() || '(unknown account)'; }
  catch (e) { return '(unknown account)'; }
}

/**
 * Create a file directly inside a folder, shared-drive safe, and return its id.
 *
 * SpreadsheetApp.create() and Drive.Files.create() without `parents` land in the runner's My Drive root first.
 * A crash before the follow-up move leaves an orphan there, and moving INTO a shared drive is governed by a
 * domain policy the runner may not control. Creating in place removes both.
 *
 * @param {string} name
 * @param {string} mimeType  e.g. MimeType.GOOGLE_SHEETS, MimeType.GOOGLE_DOCS
 * @param {string} parentId
 * @param {GoogleAppsScript.Base.Blob=} blob Content to upload/convert, or omit for an empty native file.
 * @return {string} New file id.
 * @private
 */
function createInPlace_(name, mimeType, parentId, blob) {
  const meta = { name: name, mimeType: mimeType, parents: [parentId] };
  const created = Drive.Files.create(meta, blob || null, { supportsAllDrives: true });
  return created.id;
}
