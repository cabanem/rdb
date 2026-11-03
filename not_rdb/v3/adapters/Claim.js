/**
 * @file adapters/Claim.gs — take custody of an original after its review sheet exists, whether or not the runner owns it.
 */

/** @const {string} appProperties key stamped on an original the pipeline has copied rather than moved. */
const CLAIM_KEY = 'g2s_claimed';

/**
 * Whether a prior poll already claimed this file by copy. appProperties are private to this script's project.
 * Never throws; an unreadable property means "not claimed" and the normal path decides.
 * @param {GoogleAppsScript.Drive.File} file
 * @return {boolean}
 * @private
 */
function isClaimed_(file) {
  try {
    const p = Drive.Files.get(file.getId(), { fields: 'appProperties', supportsAllDrives: true }).appProperties || {};
    return p[CLAIM_KEY] === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * Move the file into `folder`; if Drive refuses on permission grounds, copy it there instead and mark the original.
 * Returns the file that now lives in `folder` — the original on a move, the copy otherwise.
 * @param {GoogleAppsScript.Drive.File} file
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @return {GoogleAppsScript.Drive.File}
 * @throws {Error} Any non-permission failure, unchanged.
 * @private
 */
function claimOriginal_(file, folder) {
  try {
    file.moveTo(folder);
    return file;
  } catch (err) {
    if (!/access denied|permission|forbidden|not have access/i.test(String((err && err.message) || err))) throw err;
  }
  const copy = file.makeCopy(file.getName(), folder);
  const props = {}; props[CLAIM_KEY] = 'true';
  Drive.Files.update({ appProperties: props }, file.getId(), null, { supportsAllDrives: true });
  logInfo_('processIngestion', 'Copied (not moved) ' + file.getName() + ' — original is owned by ' + ownerOf_(file), '', copy.getUrl());
  return copy;
}

/**
 * Owner email for a log line; '' if Drive withholds it. Never throws.
 * @param {GoogleAppsScript.Drive.File} file
 * @return {string}
 * @private
 */
function ownerOf_(file) {
  try { return file.getOwner().getEmail() || ''; } catch (e) { return ''; }
}
