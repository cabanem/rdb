/**
 * @file 015_Logo.gs (SDC library)
 * The customer logo as an uploaded Drive file (schema 1.13 / payload 12.2).
 *
 * Until 1.12 the analyst pasted a public image URL into the "Customer logo public link" cell and it travelled as
 * customer_logo_url. Now the analyst uploads the image from their computer: the browser reads it (FileReader ->
 * base64), the host passes {name, mimeType, sizeBytes, base64} to Logo.upload through one global per host
 * (google.script.run cannot reach a library), and this module lands the bytes in the engagement's Drive folder with
 * the same two calls the config export uses - Drive.resolveDestinationFolder(purpose 'provision') and
 * Drive.shareWithIntegrationAccount - then writes the file's Drive link into the 1_customer cell. A re-upload trashes
 * the previous logo (name prefix customer_logo_<workbook id>) before creating the new one.
 *
 * On the wire the file travels as customer_logo_file_id + customer_logo_drive_url; Workato fetches the bytes with its
 * Drive connection and publishes a displayable URL. customer_logo_url stays as the deprecated legacy field for a
 * workbook whose cell still holds a public URL. The image is never resized or normalised here.
 *
 * Fallback without the control: a Drive link (or bare file ID) pasted into the cell is accepted. Logo.resolve, called
 * from Preflight 5d, opens it, checks type and size, and confirms the integration principal can read it; if it
 * cannot, the file is copied into the engagement folder, shared, and the cell is rewritten to the copy.
 *
 * Limits (also enforced in the browser by logo_control.html):
 *   MAX_BYTES  2 MB of file bytes (about 2.7 MB as base64). Logos are a few hundred KB; this stays an order of
 *              magnitude under where google.script.run payloads become unreliable.
 *   MIME       PNG and JPEG, decided by the magic bytes after decoding, never by the browser's declared type. SVG is
 *              excluded on purpose: it is XML that can carry script (an XSS surface once published at a public URL)
 *              and the main consumer is email, where Gmail and Outlook do not render it. GIF / WebP are left out for
 *              the same email-rendering reason; ALLOWED is the one place to change that.
 *
 * Scopes: DriveApp file create / trash / share, all under the drive scope every host already declares. No new scope.
 *
 * Public:
 *   Logo.MAX_BYTES, Logo.ALLOWED, Logo.FILE_PREFIX
 *   Logo.parseCell(raw)                     -> { kind, fileId, driveUrl, legacyUrl }   pure
 *   Logo.driveUrl(fileId)                   -> canonical https://drive.google.com/file/d/<id>/view   pure
 *   Logo.sniffMime(bytes)                   -> 'image/png' | 'image/jpeg' | null   pure (signed bytes)
 *   Logo.validateFile(file)                 -> { name, mimeType, bytes }   throws a user-facing Error
 *   Logo.upload(ss, file)                   -> Result (flow 'logo-upload'); data { fileId, driveUrl, fileName, cell, replaced }
 *   Logo.resolve(ss, config, integrationEmail) -> { kind, fileId, driveUrl, legacyUrl, copied }   throws a user-facing Error
 *   Logo.controlHtml()                      -> string: logo_control.html for a host to inline with <?!= ?>
 */

var Logo = {};

Logo.MAX_BYTES = 2 * 1024 * 1024;
Logo.ALLOWED = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg' });
Logo.FILE_PREFIX = 'customer_logo_';

// --- Pure helpers ----------------------------------------------------------------------------------------------------

/**
 * Read the 1_customer cell. Accepts every Drive link shape the UI hands out plus a bare file ID; anything else that is
 * an http(s) URL is the legacy public link.
 *
 *   ''                                 -> { kind: 'blank' }
 *   https://drive.google.com/file/d/<id>/view, /open?id=<id>, /uc?id=<id>, docs.google.com/.../d/<id>,
 *   lh3.googleusercontent.com/d/<id>, or <id> alone   -> { kind: 'drive', fileId, driveUrl }
 *   https://cdn.example.com/logo.png   -> { kind: 'legacy', legacyUrl }
 *   anything else                      -> { kind: 'invalid' }
 */
Logo.parseCell = function (raw) {
  var out = { kind: 'blank', fileId: null, driveUrl: null, legacyUrl: null };
  var s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (s === '') return out;

  var id = null, m;
  if ((m = /^https?:\/\/(?:drive|docs)\.google\.com\/(?:[a-z]+\/)?(?:u\/\d+\/)?(?:file\/)?d\/([A-Za-z0-9_-]+)/i.exec(s))) id = m[1];
  else if ((m = /^https?:\/\/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([A-Za-z0-9_-]+)/i.exec(s))) id = m[1];
  else if ((m = /^https?:\/\/lh\d\.googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/i.exec(s))) id = m[1];
  else if (/^[A-Za-z0-9_-]{20,}$/.test(s)) id = s;

  if (id) { out.kind = 'drive'; out.fileId = id; out.driveUrl = Logo.driveUrl(id); return out; }
  if (/^https?:\/\/\S+$/i.test(s)) { out.kind = 'legacy'; out.legacyUrl = s; return out; }
  out.kind = 'invalid';
  return out;
};

Logo.driveUrl = function (fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
};

/** Magic bytes. Apps Script byte arrays are signed (-128..127), so compare after & 0xFF. */
Logo.sniffMime = function (bytes) {
  if (!bytes || bytes.length < 4) return null;
  var b = function (i) { return bytes[i] & 0xFF; };
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  return null;
};

Logo._mb = function (bytes) { return (Number(bytes) / 1048576).toFixed(1).replace(/\.0$/, ''); };
Logo._allowedList = function () { return 'PNG or JPEG'; };

/**
 * Check what the browser sent before anything touches Drive. Size is checked on the declared size first (cheap) and
 * on the decoded bytes second (authoritative). The MIME type comes from the bytes; the browser's value only
 * improves the error message.
 *
 * @param {{name: string, mimeType: string, sizeBytes: number, base64: string}} file
 * @returns {{name: string, mimeType: string, bytes: number[]}}
 */
Logo.validateFile = function (file) {
  if (!file || typeof file.base64 !== 'string' || file.base64 === '') throw new Error('No file content was received.');
  var raw = String(file.name || '').replace(/[\\/]/g, '_').trim();
  if (!raw) throw new Error('The file has no name.');
  if (Number(file.sizeBytes) > Logo.MAX_BYTES) {
    throw new Error('"' + raw + '" is ' + Logo._mb(file.sizeBytes) + ' MB; the limit for a logo is ' + Logo._mb(Logo.MAX_BYTES) + ' MB.');
  }
  var bytes;
  try { bytes = Utilities.base64Decode(file.base64); }
  catch (e) { throw new Error('The file content could not be decoded (' + e.message + '). Choose the file again.'); }
  if (bytes.length > Logo.MAX_BYTES) {
    throw new Error('"' + raw + '" is ' + Logo._mb(bytes.length) + ' MB; the limit for a logo is ' + Logo._mb(Logo.MAX_BYTES) + ' MB.');
  }
  var mime = Logo.sniffMime(bytes);
  if (!mime || !Logo.ALLOWED[mime]) {
    throw new Error('"' + raw + '" is not a ' + Logo._allowedList() + ' image' +
      (file.mimeType ? ' (the browser reported ' + file.mimeType + ')' : '') + '. Export the logo as PNG or JPEG and try again.');
  }
  var stem = raw.replace(/\.[^.]*$/, '').slice(0, 120) || 'logo';
  return { name: stem + '.' + Logo.ALLOWED[mime], mimeType: mime, bytes: bytes };
};

// --- Upload ----------------------------------------------------------------------------------------------------------

/**
 * Land an uploaded image and point the 1_customer cell at it. Canonical Result; the host renders it.
 *
 * Pipeline: Config.build -> validateFile -> land (folder, sweep, create, share) -> write cell.
 *
 * @param {Spreadsheet} ss
 * @param {{name: string, mimeType: string, sizeBytes: number, base64: string}} file
 * @returns {Object} Result (flow 'logo-upload'); data { fileId, driveUrl, fileName, cell, replaced }
 */
Logo.upload = function (ss, file) {
  if (!ss) throw new Error('Logo.upload: ss is required.');
  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  log('INFO', 'Starting customer logo upload' + (file && file.name ? ' (' + file.name + ')' : '') + '...');

  try {
    var config = Stage.run('config', function () { return Config.build(ss); });
    var email = Stage.run('config', function () { return Logo._integrationEmail(config); });
    var checked = Stage.run('validate-file', function () { return Logo.validateFile(file); });
    var blob = Utilities.newBlob(checked.bytes, checked.mimeType, checked.name);
    var landed = Stage.run('land', function () { return Logo._land(ss, config, blob, email); });
    if (landed.replaced > 0) log('INFO', 'Trashed ' + landed.replaced + ' previous logo file(s).');
    log('INFO', 'Logo saved to Drive as ' + landed.fileName + ' (' + landed.fileId + '), shared with ' + email + '.');
    var cell = Stage.run('write-cell', function () { return Logo._writeCell(ss, config, landed.driveUrl); });
    log('SUCCESS', 'Customer logo updated: ' + cell + ' -> ' + landed.driveUrl);

    return Result.ok({
      flow: 'logo-upload',
      correlationId: correlationId,
      message: 'Logo "' + landed.fileName + '" saved to Drive and linked from ' + cell + '.',
      data: { fileId: landed.fileId, driveUrl: landed.driveUrl, fileName: landed.fileName, cell: cell, replaced: landed.replaced }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Logo upload failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow: 'logo-upload',
      correlationId: correlationId,
      message: 'Logo upload failed at ' + stage + ':\n\n' + e.message,
      error: e
    });
  }
};

/**
 * Create the blob in the engagement folder (the config export's provision folder), after trashing any previous
 * logo of this workbook, and share it with the integration principal exactly as the config JSON is shared.
 * The stored name is customer_logo_<workbook id>.<ext>; the analyst's file name is kept on the Drive description.
 */
Logo._land = function (ss, config, blob, integrationEmail) {
  var folder = Drive.resolveDestinationFolder(ss, config, { purpose: 'provision' });
  var prefix = Logo.FILE_PREFIX + ss.getId();
  var replaced = Drive.trashByNamePrefix(folder, prefix);
  var ext = Logo.ALLOWED[blob.getContentType()] || 'bin';
  var original = blob.getName();
  var file = folder.createFile(blob.setName(prefix + '.' + ext));
  try { file.setDescription('Customer logo for workbook ' + ss.getId() + ' (uploaded as "' + original + '")'); } catch (e) { /* cosmetic */ }
  Drive.shareWithIntegrationAccount(file.getId(), integrationEmail);
  return { fileId: file.getId(), driveUrl: Logo.driveUrl(file.getId()), fileName: file.getName(), replaced: replaced };
};

/** Write the link into the registry cell (named range first, label fallback with heal). Returns the A1 address. */
Logo._writeCell = function (ss, config, value) {
  var def = Logo._def();
  var sheet = ss.getSheetByName(config.sheets.customer);
  if (!sheet) throw new Error('Sheet "' + config.sheets.customer + '" not found; cannot record the logo link.');
  var range;
  try { range = ss.getRangeByName(def.rangeName); if (range) range.getValue(); } catch (e) { range = null; }
  if (!range) {
    var hit = Util.findLabelCell(sheet, def.label);
    if (!hit) {
      throw new Error('Could not locate "' + def.label + '" (' + def.rangeName + ') on ' + config.sheets.customer +
        '. Run "Migrate workbook schema" and retry.');
    }
    range = sheet.getRange(hit.row, hit.col + def.valueOffset);
    try { ss.setNamedRange(def.rangeName, range); } catch (e) { /* read still works via the label */ }
  }
  range.setValue(value);
  return range.getSheet().getName() + '!' + range.getA1Notation();
};

Logo._def = function () {
  for (var i = 0; i < CUSTOMER_FIELDS.length; i++) if (CUSTOMER_FIELDS[i].type === 'driveFile') return CUSTOMER_FIELDS[i];
  throw new Error('CUSTOMER_FIELDS has no driveFile entry; Schema.gs and Logo.gs are out of sync.');
};

/** Same rule as Preflight check 4, so an upload fails with the same message a provision would. */
Logo._integrationEmail = function (config) {
  var email = config && config.sharing && config.sharing.integrationAccountEmail;
  if (!email || !Util.isValidEmailShape(email)) {
    throw new Error('Workato OAuth account email is missing or malformed. Check _developer_settings ' +
      String.fromCharCode(8594) + ' sharing.integrationAccountEmail. Workato cannot read the logo without this share.');
  }
  return email;
};

// --- Resolve (Preflight 5d) --------------------------------------------------------------------------------------------

/**
 * Make sure whatever the cell holds is something Workato can use, and say exactly what is wrong when it is not.
 * Blank is NOT an error here (the registry's `required` and Preflight 5b own that). A legacy public URL passes as
 * the deprecated field. A Drive file is opened, type- and size-checked, and shared or copied as needed; the cell is
 * rewritten only when a copy was made.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config
 * @param {string}      integrationEmail - config.sharing.integrationAccountEmail, already checked by the caller.
 * @returns {{kind: string, fileId: ?string, driveUrl: ?string, legacyUrl: ?string, mimeType: ?string, copied: boolean}}
 *          mimeType is 'image/png' | 'image/jpeg' for a Drive file (from its bytes), null for blank and legacy.
 */
Logo.resolve = function (ss, config, integrationEmail) {
  var def = Logo._def();
  var raw = Customer.readOne(ss, config, def.key);
  var parsed = Logo.parseCell(raw);
  var out = { kind: parsed.kind, fileId: parsed.fileId, driveUrl: parsed.driveUrl, legacyUrl: parsed.legacyUrl, mimeType: null, copied: false };
  var where = 'The "' + def.label + '" value in the ' + config.sheets.customer + ' tab';

  if (parsed.kind === 'blank' || parsed.kind === 'legacy') return out;
  if (parsed.kind === 'invalid') {
    throw new Error(where + ' is neither a Google Drive link nor a web address. Use "Upload customer logo" ' +
      '(guide sidebar or implementations app), or paste the Drive link of the image file.');
  }

  var file;
  try { file = DriveApp.getFileById(parsed.fileId); file.getName(); }
  catch (e) {
    throw new Error(where + ' points at a Drive file you cannot open (' + parsed.fileId + '). Ask its owner to share ' +
      'it with you, or upload the image with "Upload customer logo". Underlying error: ' + e.message);
  }
  // Size first: the type check below downloads the file, so an oversized one is refused before any bytes move.
  var size = Number(file.getSize() || 0);
  if (size > Logo.MAX_BYTES) {
    throw new Error(where + ' points at "' + file.getName() + '", which is ' + Logo._mb(size) + ' MB; the limit for a logo is ' +
      Logo._mb(Logo.MAX_BYTES) + ' MB. Upload a smaller export of the image.');
  }
  // Type from the bytes, the same rule an upload gets (validateFile). Drive's own type is whatever the uploader's
  // browser declared, so it only improves the message. The sniffed type is what travels as customer_logo_mime_type.
  var declared = String(file.getMimeType() || '');
  var bytes;
  try { bytes = file.getBlob().getBytes(); }
  catch (e) {
    throw new Error(where + ' points at "' + file.getName() + '", which could not be read to check its type: ' + e.message);
  }
  var mime = Logo.sniffMime(bytes);
  if (!mime || !Logo.ALLOWED[mime]) {
    throw new Error(where + ' points at "' + file.getName() + '", which is not a ' + Logo._allowedList() + ' image' +
      (declared ? ' (Drive reports ' + declared + ')' : '') + '. Upload the logo as PNG or JPEG.');
  }
  out.mimeType = mime;
  if (Logo._readableBy(file, integrationEmail)) return out;

  // Not readable by the principal: copy into the engagement folder and share the copy, like an upload. The copy is
  // built from the sniffed type, so _land names it .png / .jpg even when Drive's declared type was wrong.
  var landed;
  try {
    landed = Logo._land(ss, config, Utilities.newBlob(bytes, mime, file.getName()), integrationEmail);
  } catch (e) {
    throw new Error(where + ' points at "' + file.getName() + '", which the Workato account (' + integrationEmail +
      ') cannot read, and copying it into the engagement folder failed: ' + e.message);
  }
  Logo._writeCell(ss, config, landed.driveUrl);
  console.log('Customer logo ' + parsed.fileId + ' was not readable by ' + integrationEmail + '; copied as ' + landed.fileId + '.');
  return { kind: 'drive', fileId: landed.fileId, driveUrl: landed.driveUrl, legacyUrl: null, mimeType: mime, copied: true };
};

/**
 * Can `email` read the file? True for link- or domain-shared files and when the address is the owner or on the
 * editor or viewer list. Any failure to read the ACL (a viewer cannot list editors) counts as "no", which makes the
 * caller copy the file: the cheap, always-correct remedy.
 */
Logo._readableBy = function (file, email) {
  var target = String(email || '').trim().toLowerCase();
  try {
    var access = file.getSharingAccess();
    if (access && access !== DriveApp.Access.PRIVATE) return true;
  } catch (e) { /* fall through to the ACL lists */ }
  try {
    var people = [file.getOwner()].concat(file.getEditors(), file.getViewers());
    for (var i = 0; i < people.length; i++) {
      if (people[i] && String(people[i].getEmail() || '').toLowerCase() === target) return true;
    }
  } catch (e) { /* cannot see the ACL */ }
  return false;
};

// --- UI --------------------------------------------------------------------------------------------------------------

/**
 * The upload control, written once and inlined by both hosts: `<?!= SDC.Logo.controlHtml() ?>` in a template. The
 * fragment defines window.SdcLogo.mount(hostElement, { onFile, current, maxBytes }); the host decides what to do
 * with the {name, mimeType, sizeBytes, base64} it is handed (the sidebar calls its uploadCustomerLogo global, the
 * kickoff app keeps it until the workbook exists).
 */
Logo.controlHtml = function () {
  return HtmlService.createHtmlOutputFromFile('logo_control').getContent();
};
