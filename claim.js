/**
 * @file Claim.gs — take custody of an original after its review sheet exists, whether or not the runner owns it.
 *
 * WHY
 *   Intake files arrive three ways. Dashboard uploads and picker imports are created BY the runner (stageBlob_), so
 *   the runner owns them and moveTo just works. A file dropped straight into the Intake folder is owned by whoever
 *   dropped it, and moving someone else's file is the one Drive operation that depends on their settings — it is what
 *   threw "Access denied: DriveApp". So: try the move; if Drive refuses, COPY the file into the destination (the copy
 *   is runner-owned and permanent) and stamp the original with an appProperty so the next poll skips it. The review
 *   sheet is re-pointed at the copy, because the dropper can delete the original at any time and the copy is what the
 *   reviewer and Workato need.
 *
 * ORDERING (unchanged): extract -> review sheet -> claim. The claim is last so a crash never leaves a file in
 * Processed with no review sheet. The only duplicate window is still "sheet created, claim not finished".
 *
 * WIRING in processIngestion():
 *   while (files.hasNext()) {
 *     const file = files.next();
 *     if (isClaimed_(file)) continue;                       // a prior poll copied it; the original is still here
 *     ...
 *     const sheet = extractOneFile_(file, cfg, pending);
 *     const kept = claimOriginal_(file, processed);         // was: moveFile_(file, processed)
 *     if (kept.getId() !== file.getId()) repointSheet_(sheet.id, kept);
 *     ...
 *   } catch (err) {
 *     ...
 *     try { claimOriginal_(file, failed); } catch (e) { /* leave in Intake to retry */ }   // was: moveFile_(file, failed)
 *   }
 * Also skip claimed files in countIntakeFiles_() (Intake.gs) so the dashboard's "waiting" count stays honest.
 *
 * Requires the Advanced Drive Service (v3), already enabled.
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
 * Point a review sheet's "Original file" link and "Source file ID" at the kept copy.
 * @param {string} sheetId Review spreadsheet id.
 * @param {GoogleAppsScript.Drive.File} kept
 * @private
 */
function repointSheet_(sheetId, kept) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(REVIEW_SHEET_TAB) || ss.getSheets()[0];
  setMeta_(sheet, META.SOURCE_ID, kept.getId());
  const col = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 30), 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (sameLabel_(col[i][0], META.ORIGINAL)) {
      sheet.getRange(i + 1, 2).setFormula('=HYPERLINK("' + kept.getUrl() + '","' + kept.getName().replace(/"/g, "'") + '")');
      break;
    }
  }
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
