/**
 * @file pipeline/Extract.gs
 * One contract in, one parsed field map out: turn the Drive file into content parts, prompt the model through an
 * {@link Extractor}, and split the [[Label]]-delimited answer.
 *
 * Three layers, so the middle one can be tested without Drive, Sheets or a network:
 *   buildExtractionParts_(file)              Drive in, content parts out.
 *   extractFields_(parts, cfg, extractor)    content parts in, parsed fields out. Pure given the extractor.
 *   extractOneFile_(...)                     the two above plus createReviewSheet_ (pipeline/ReviewSheet.gs).
 * The extractor is a parameter with a default, not a global: processIngestion() passes vertexExtractor_(), tests
 * pass a fake, and the service-account switch is a different extractor, not a different pipeline.
 */

// --- CONSTANTS -----------------------------------------------------------------------------------
/** @const {number} Largest PDF (raw bytes) we send to Gemini inline. */
const INLINE_PDF_MAX_BYTES = 15 * 1024 * 1024;

// --- EXTRACTION ----------------------------------------------------------------------------------
/**
 * Extract one file, parse its fields, and write the review sheet into `pending`.
 * @param {GoogleAppsScript.Drive.File} file Source contract.
 * @param {Config} cfg Pipeline configuration.
 * @param {GoogleAppsScript.Drive.Folder} pendingFolder Destination for the review sheet.
 * @param {Schema} [schema] Cached field schema; {} or omitted = plain sheet.
 * @param {Extractor} [extractor] The model call; defaults to the Vertex one (adapters/Vertex.gs).
 * @return {ReviewSheetRef}
 * @private
 */
function extractOneFile_(file, cfg, pendingFolder, schema, extractor) {
  const parts = buildExtractionParts_(file);              // [{text}] or [{inlineData}]
  const result = extractFields_(parts, cfg, extractor || vertexExtractor_());
  return createReviewSheet_(result.parsed, file, result.sources, cfg, pendingFolder, schema || {});
}

/**
 * Prompt the model with the content parts and parse its answer into a label -> text map. The only I/O is the
 * extractor call itself, so with a fake extractor this is a pure function of (parts, cfg).
 * @param {ContentPart[]} parts From buildExtractionParts_().
 * @param {Config} cfg Supplies prompt_template and output_fields.
 * @param {Extractor} extractor
 * @return {{parsed:Object.<string,string>, sources:string, debug:string}} Every output field present; unmatched ones blank.
 * @throws {Error} Whatever the extractor throws (safety, recitation, empty, transport) — never caught here, so a
 *   blocked extraction can never be staged as a clean one.
 * @private
 */
function extractFields_(parts, cfg, extractor) {
  const prompted = promptLabels_(cfg);                   // [manual] rows are the reviewer's, not the model's
  const prompt = cfg.prompt_template + fieldInstruction_(prompted);
  const result = extractor.extract(cfg, prompt, parts);  // {text, sources, debug}
  const parsed = parseResult_(result.text, prompted);
  cfg.output_fields.forEach(function (f) { if (!(f in parsed)) parsed[f] = ''; });   // every output field present
  return {
    parsed: parsed,
    sources: result.sources || '',
    debug: result.debug || ''
  };
}

/**
 * The output_fields the model is asked for: everything except `[manual]` rows. Pure.
 * @param {Config} cfg
 * @return {string[]}
 * @private
 */
function promptLabels_(cfg) {
  return (cfg.output_fields || []).filter(function (l) { return fieldRole_(cfg, l) !== 'manual'; });
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

// --- PROMPT AND PARSE (PURE) ---------------------------------------------------------------------
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
    'If a field is not present in the contract, leave its section completely empty: do not write ' +
    '"Not mentioned", "N/A" or any other placeholder.';
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
