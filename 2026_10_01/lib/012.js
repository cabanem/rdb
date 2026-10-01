/**
 * @file 012_Assist.gs (SDC library)
 * Config assistant: grounded Q&A for analysts over the master-config documentation.
 *
 * Two halves, one file:
 *   DIGEST  Assist.buildDigest(config, opts)  - scheduled. Reads every source in the corpus folder (the user guide,
 *           the connector source, TPL-02, reference tabs of the template workbook), fingerprints them, and rewrites
 *           ONE digest file in that folder only when a source changed. Nothing else is pre-computed: the whole
 *           corpus fits one Gemini context, so there is no retrieval layer.
 *   ASK     Assist.ask(ss, question, opts)    - synchronous. Loads the digest, optionally the open workbook's latest
 *           _validation_results, asks Gemini with an analyst-facing system instruction, logs the exchange, returns
 *           a Result whose data carries the answer.
 *
 * The corpus is read-only to this file. It never writes to a numbered tab.
 *
 * _developer_settings rows (category `assist`; see Config.build):
 *   gcpProjectId      GCP project whose Vertex AI the analyst calls (their own identity; needs roles/aiplatform.user)
 *   gcpLocation       default us-central1
 *   geminiModel       default gemini-2.5-flash
 *   corpusFolderId    Drive folder holding the sources and the digest
 *   templateSheetId   optional: the blank master-config workbook; its reference tabs join the corpus
 *   logSheetId        optional: a shared Google Sheet; one row per ask. Blank = no Q&A log
 *   includeFindings   optional, default FALSE: send the workbook's latest _validation_results with each ask
 *
 * Public:
 *   Assist.buildDigest(config, opts)  -> { built, fingerprint, fileId, bytes, sources, reason }
 *   Assist.ask(ss, question, opts)    -> Result (flow 'assist'; data: { answer, fingerprint, builtAt, durationMs, findingsIncluded })
 *   Assist.status(ss)                 -> { configured, missing, digest: { exists, builtAt, fingerprint, bytes, sources } | null }
 *
 * Library dependency: GeminiLib (lib_gemini-client, identifier GeminiLib). Vertex AI runs under the calling user.
 */

var Assist = {};

// --- CONSTANTS -------------------------------------------------------------------------------------------------------------
var ASSIST_DIGEST_FILE_NAME = 'config_assist_digest.md';
var ASSIST_DIGEST_HEADER_RE = /^<!-- sdc-assist digest \| fingerprint: ([0-9a-f]{64}) \| built: (\S+) \| sources: (\d+) -->/;
var ASSIST_TEMPLATE_TABS    = ['.user_guide', '.math_notation', '.regex', '_error_translation'];
var ASSIST_TEXT_EXT_RE      = /\.(md|txt|rb|py|js|gs|json|csv|tsv|yaml|yml)$/i;
var ASSIST_MAX_FINDING_ROWS = 80;
var ASSIST_MAX_ANSWER_LOG   = 4000;      // characters of the answer kept in the Q&A log row

var ASSIST_LOG_HEADERS = Object.freeze([
  'Timestamp', 'User', 'Workbook', 'Question', 'Answer', 'Status', 'Duration ms', 'Findings included', 'Corpus fingerprint', 'Correlation ID'
]);

var ASSIST_SYSTEM_INSTRUCTION = [
  'You are the configuration assistant for the Supplier Data Collection (SDC) master-config workbook. You answer analysts',
  'who fill in tabs 1_customer to 7_form and want to know what a setting does, why preflight failed, or what the supplier will see.',
  '',
  'Ground every answer in the corpus provided in the user message. The source marked role=primary is the analyst user guide:',
  'answer in its vocabulary and cite it by section, e.g. (Guide: 4_fields). Sources marked role=reference are platform code and',
  'reference tabs; use them to be precise about behaviour, but never quote code, variable names or recipe IDs to the analyst.',
  'If the corpus does not cover the question, say so in one sentence and suggest the analyst ask the integration developer;',
  'do not guess.',
  '',
  'Rules of the answer:',
  '- Lead with the answer, then at most a few short sentences or a short list. No preamble, no restating the question.',
  '- Name the exact tab, column and value to change. Never suggest editing a tab whose name starts with an underscore.',
  '- When workbook findings are supplied, explain the failing or warning checks against the guide and say which cell to fix first.',
  '- Distinguish what Excel enforces in-cell from what is checked on submission; the guide is explicit about this.',
  '- Plain text with simple markdown (short lists, backticks for values). No tables, no headings.'
].join('\n');

// --- DIGEST ----------------------------------------------------------------------------------------------------------------
/**
 * Rebuild the digest if any source changed. Safe to run on a nightly trigger from any workbook whose
 * _developer_settings carry the assist rows: on an unchanged corpus it reads metadata only and exits.
 *
 * @param {Object} config           Config.build(ss) result; needs config.assist.corpusFolderId
 * @param {{force?: boolean}} opts  force: rebuild even when the fingerprint matches
 */
Assist.buildDigest = function(config, opts) {
  opts = opts || {};
  var a = Assist._settings(config, ['corpusFolderId']);
  var folder = DriveApp.getFolderById(a.corpusFolderId);

  var sources = Assist._collectSources(a, folder);
  if (sources.length === 0) {
    var e0 = new Error('Corpus folder ' + a.corpusFolderId + ' holds no readable source (Google Doc, .md, .txt, .rb, .py ...).');
    e0.stage = 'corpus'; throw e0;
  }

  var fingerprint = Util.sha256Hex(sources.map(function(s) { return s.stamp; }).join('\n'));
  var existing = Assist._findDigestFile(folder);

  if (existing && !opts.force) {
    var head = Assist.parseDigestHeader(Assist._firstLine(existing.getBlob().getDataAsString()));
    if (head && head.fingerprint === fingerprint) {
      return { built: false, reason: 'unchanged', fingerprint: fingerprint, fileId: existing.getId(),
               bytes: existing.getSize(), sources: sources.map(function(s) { return s.name; }) };
    }
  }

  // Only now read source bodies: an unchanged corpus never pays for the reads.
  var bodies = sources.map(function(s) { return { name: s.name, role: s.role, kind: s.kind, text: s.read() }; });
  var text = Assist.assembleDigest(bodies, fingerprint, new Date().toISOString());

  var file;
  if (existing) { existing.setContent(text); file = existing; }
  else          { file = folder.createFile(ASSIST_DIGEST_FILE_NAME, text, MimeType.PLAIN_TEXT); }

  return { built: true, reason: existing ? 'changed' : 'created', fingerprint: fingerprint, fileId: file.getId(),
           bytes: text.length, sources: bodies.map(function(b) { return b.name; }) };
};

/**
 * Pure. One markdown document: a machine-readable header line, then one section per source. Section order is
 * primary first so the guide's headings are what the model sees first and cites.
 */
Assist.assembleDigest = function(bodies, fingerprint, builtAtIso) {
  var ordered = bodies.slice().sort(function(x, y) {
    if (x.role === y.role) return x.name.localeCompare(y.name);
    return x.role === 'primary' ? -1 : 1;
  });
  var out = ['<!-- sdc-assist digest | fingerprint: ' + fingerprint + ' | built: ' + builtAtIso + ' | sources: ' + ordered.length + ' -->',
             '', '# SDC config assistant corpus', ''];
  ordered.forEach(function(b) {
    out.push('<!-- source: ' + b.name + ' | role: ' + b.role + ' | kind: ' + b.kind + ' -->');
    out.push('# SOURCE ' + b.name + ' (role=' + b.role + ', ' + b.kind + ')');
    out.push('');
    out.push(String(b.text || '').replace(/\r\n/g, '\n').trim());
    out.push('');
  });
  return out.join('\n');
};

/** Pure. Reads the header line back. null when the file is not a digest this version wrote. */
Assist.parseDigestHeader = function(line) {
  var m = ASSIST_DIGEST_HEADER_RE.exec(String(line || ''));
  return m ? { fingerprint: m[1], builtAt: m[2], sources: Number(m[3]) } : null;
};

/** Pure. A source's role from its kind and name: the guide is primary, everything else reference. */
Assist.classifySource = function(name, mimeType) {
  if (mimeType === MimeType.GOOGLE_DOCS) return 'primary';
  return /guide/i.test(String(name || '')) ? 'primary' : 'reference';
};

/**
 * Enumerate sources without reading bodies: { name, role, kind, stamp, read }.
 * stamp = id|lastUpdated, which is all the fingerprint needs.
 */
Assist._collectSources = function(a, folder) {
  var sources = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName(), mime = f.getMimeType();
    if (name === ASSIST_DIGEST_FILE_NAME) continue;
    if (mime === MimeType.GOOGLE_DOCS) {
      sources.push({ name: name, role: Assist.classifySource(name, mime), kind: 'google-doc',
                     stamp: f.getId() + '|' + f.getLastUpdated().getTime(),
                     read: Assist._readGoogleDoc.bind(null, f.getId()) });
    } else if (ASSIST_TEXT_EXT_RE.test(name) || /^text\//.test(mime)) {
      sources.push({ name: name, role: Assist.classifySource(name, mime), kind: 'text',
                     stamp: f.getId() + '|' + f.getLastUpdated().getTime(),
                     read: (function(file) { return function() { return file.getBlob().getDataAsString('UTF-8'); }; })(f) });
    }
    // Sheets, PDFs, images in the folder are ignored on purpose (the template workbook is named explicitly below).
  }
  if (a.templateSheetId) {
    var tf = DriveApp.getFileById(a.templateSheetId);
    sources.push({ name: 'master_config template reference tabs', role: 'reference', kind: 'sheet-tabs',
                   stamp: tf.getId() + '|' + tf.getLastUpdated().getTime(),
                   read: Assist._readTemplateTabs.bind(null, a.templateSheetId) });
  }
  return sources;
};

/** Google Doc -> markdown via Drive export (headings survive, which is what the citations hang on); plain text on failure. */
Assist._readGoogleDoc = function(fileId) {
  var token = ScriptApp.getOAuthToken();
  var base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/export?mimeType=';
  var tryMime = function(mime) {
    var r = UrlFetchApp.fetch(base + encodeURIComponent(mime), {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    return r.getResponseCode() === 200 ? r.getContentText('UTF-8') : null;
  };
  var md = tryMime('text/markdown');
  if (md !== null) return md;
  var txt = tryMime('text/plain');
  if (txt !== null) return txt;
  var e = new Error('Could not export Google Doc ' + fileId + ' as markdown or text.');
  e.stage = 'corpus'; throw e;
};

/** The template workbook's reference tabs as TSV blocks. Missing tabs are skipped, not fatal. */
Assist._readTemplateTabs = function(sheetId) {
  var ss = SpreadsheetApp.openById(sheetId);
  var out = [];
  ASSIST_TEMPLATE_TABS.forEach(function(tabName) {
    var sh = ss.getSheetByName(tabName);
    if (!sh) return;
    var rows = sh.getDataRange().getValues().filter(function(r) {
      return r.some(function(v) { return String(v == null ? '' : v).trim() !== ''; });
    });
    out.push('## Tab ' + tabName);
    out.push(rows.map(function(r) {
      return r.map(function(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }).join('\t').replace(/\t+$/, '');
    }).join('\n'));
    out.push('');
  });
  return out.join('\n');
};

Assist._findDigestFile = function(folder) {
  var it = folder.getFilesByName(ASSIST_DIGEST_FILE_NAME);
  return it.hasNext() ? it.next() : null;
};

Assist._firstLine = function(text) {
  var i = String(text || '').indexOf('\n');
  return i < 0 ? String(text || '') : text.substring(0, i);
};

/** Load the digest (text + header). Throws stage 'digest' when the folder has none yet. */
Assist._loadDigest = function(a) {
  var folder = DriveApp.getFolderById(a.corpusFolderId);
  var file = Assist._findDigestFile(folder);
  if (!file) {
    var e = new Error('No ' + ASSIST_DIGEST_FILE_NAME + ' in the corpus folder yet. Run "Build assistant corpus" once.');
    e.stage = 'digest'; throw e;
  }
  var text = file.getBlob().getDataAsString('UTF-8');
  var head = Assist.parseDigestHeader(Assist._firstLine(text)) || { fingerprint: '', builtAt: '', sources: 0 };
  return { text: text, fingerprint: head.fingerprint, builtAt: head.builtAt, sources: head.sources, bytes: text.length, fileId: file.getId() };
};

// --- ASK -------------------------------------------------------------------------------------------------------------------
/**
 * Answer one analyst question against the digest.
 *
 * @param {Spreadsheet} ss       the open config workbook (settings, log context, optional findings)
 * @param {string}      question
 * @param {{includeFindings?: boolean}} [opts]  overrides the _developer_settings default for this ask
 * @returns {Object} Result
 */
Assist.ask = function(ss, question, opts) {
  if (!ss) throw new Error('Assist.ask: ss is required.');
  opts = opts || {};
  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  var started = Date.now();
  var q = String(question || '').trim();

  try {
    if (!q) { var e0 = new Error('Question is empty.'); e0.stage = 'input'; throw e0; }

    var config = Stage.run('config', function() { return Config.build(ss); });
    var a = Stage.run('config', function() { return Assist._settings(config, ['corpusFolderId', 'gcpProjectId']); });

    var digest = Stage.run('digest', function() { return Assist._loadDigest(a); });

    var includeFindings = (opts.includeFindings !== undefined) ? Boolean(opts.includeFindings) : a.includeFindings;
    var findings = includeFindings ? Stage.run('findings', function() { return Assist.latestFindings(ss); }) : null;

    var prompt = Assist.buildPrompt(q, digest.text, findings);

    var answer = Stage.run('gemini', function() {
      var client = GeminiLib.newClient(a.gcpProjectId, a.gcpLocation, a.geminiModel);
      return String(client.generateContent(prompt, {
        systemInstruction: ASSIST_SYSTEM_INSTRUCTION,
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        maxRetries: 2
      }) || '');
    });

    var blocked = /^(Error:|Analysis blocked|Analysis failed|No text returned)/.test(answer);
    var durationMs = Date.now() - started;
    var status = blocked ? 'blocked' : 'ok';

    Assist._appendQaLog(a, ss, q, answer, status, durationMs, !!findings, digest.fingerprint, correlationId);
    log(blocked ? 'WARNING' : 'INFO', 'Assistant ' + status + ' in ' + durationMs + ' ms (corpus ' + digest.fingerprint.substring(0, 12) + ').');

    return Result.ok({
      flow: 'assist', correlationId: correlationId,
      message: blocked ? 'The model returned no usable answer.' : 'Answered.',
      data: { answer: answer, fingerprint: digest.fingerprint, builtAt: digest.builtAt, durationMs: durationMs,
              findingsIncluded: !!findings },
      warnings: blocked ? [answer] : []
    });
  } catch (e) {
    var durationFail = Date.now() - started;
    log('ERROR', 'Assistant failed at ' + (e.stage || 'unknown') + ': ' + e.message);
    try { Assist._appendQaLog(Assist._settingsOrNull(ss), ss, q, '', 'error: ' + (e.stage || 'unknown'), durationFail, false, '', correlationId); } catch (ignore) {}
    return Result.fail({
      flow: 'assist', correlationId: correlationId,
      message: 'The assistant could not answer: ' + e.message,
      error: e
    });
  }
};

/** Pure. The user turn: question first, then the optional findings block, then the corpus. */
Assist.buildPrompt = function(question, digestText, findings) {
  var parts = ['QUESTION:', question, ''];
  if (findings && findings.rows.length) {
    parts.push('THIS WORKBOOK\'S LATEST PREFLIGHT FINDINGS (overall: ' + findings.overall + '; ' + findings.rows.length +
               ' failing or warning rows' + (findings.truncated ? ', truncated' : '') + '):');
    parts.push('check\tseverity\tentity\tname\tissue');
    findings.rows.forEach(function(r) { parts.push([r.check, r.severity, r.entity, r.name, r.issue].join('\t')); });
    parts.push('');
  } else if (findings) {
    parts.push('THIS WORKBOOK\'S LATEST PREFLIGHT FINDINGS: no failing or warning checks (overall: ' + findings.overall + ').');
    parts.push('');
  }
  parts.push('CORPUS:');
  parts.push(digestText);
  return parts.join('\n');
};

/**
 * The open workbook's _validation_results, reduced to fail/warn rows. The sheet holds one run (ValidationReport
 * clears before each write), so no correlation filtering is needed. Returns { overall, rows, truncated }.
 */
Assist.latestFindings = function(ss) {
  var sh = ss.getSheetByName('_validation_results');
  if (!sh || sh.getLastRow() < 2) return { overall: 'no run yet', rows: [], truncated: false };
  var data = sh.getDataRange().getValues();
  return Assist.reduceFindings(data);
};

/** Pure. Header row + rows in VR_HEADERS order -> fail/warn rows only, capped. */
Assist.reduceFindings = function(data) {
  var header = (data[0] || []).map(function(h) { return String(h).trim(); });
  var col = function(name) { return header.indexOf(name); };
  var cOverall = col('Overall'), cCheck = col('Check'), cSev = col('Severity'), cEnt = col('Entity'), cName = col('Name'), cIssue = col('Issue');
  var rows = [], overall = '', truncated = false;
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!overall && cOverall >= 0 && r[cOverall]) overall = String(r[cOverall]);
    var sev = String(cSev >= 0 ? r[cSev] : '').toLowerCase();
    if (sev !== 'fail' && sev !== 'warn') continue;
    if (rows.length >= ASSIST_MAX_FINDING_ROWS) { truncated = true; break; }
    rows.push({ check: String(r[cCheck] || ''), severity: sev, entity: String(cEnt >= 0 ? r[cEnt] || '' : ''),
                name: String(cName >= 0 ? r[cName] || '' : ''), issue: String(cIssue >= 0 ? r[cIssue] || '' : '') });
  }
  return { overall: overall || 'unknown', rows: rows, truncated: truncated };
};

// --- STATUS ----------------------------------------------------------------------------------------------------------------
/** What the sidebar shows before the first question: configured or not, and how fresh the corpus is. */
Assist.status = function(ss) {
  var out = { configured: false, missing: [], digest: null };
  try {
    var config = Config.build(ss);
    var a = config.assist || {};
    ['gcpProjectId', 'corpusFolderId'].forEach(function(k) { if (!a[k]) out.missing.push('assist.' + k); });
    out.configured = out.missing.length === 0;
    if (a.corpusFolderId) {
      var file = Assist._findDigestFile(DriveApp.getFolderById(a.corpusFolderId));
      if (file) {
        var head = Assist.parseDigestHeader(Assist._firstLine(file.getBlob().getDataAsString())) || {};
        out.digest = { exists: true, builtAt: head.builtAt || '', fingerprint: head.fingerprint || '',
                       sources: head.sources || 0, bytes: file.getSize() };
      } else {
        out.digest = { exists: false };
      }
    }
  } catch (e) {
    out.missing.push(e.message);
  }
  return out;
};

// --- SETTINGS + LOG --------------------------------------------------------------------------------------------------------
Assist._settings = function(config, required) {
  var a = (config && config.assist) || {};
  var missing = (required || []).filter(function(k) { return !a[k]; });
  if (missing.length) {
    var e = new Error('_developer_settings is missing assist row(s): ' + missing.join(', ') + '.');
    e.stage = 'config'; throw e;
  }
  return a;
};

Assist._settingsOrNull = function(ss) {
  try { return Config.build(ss).assist || null; } catch (e) { return null; }
};

/** One row per ask in the shared log sheet. Best-effort: never fails the ask. */
Assist._appendQaLog = function(a, ss, question, answer, status, durationMs, findingsIncluded, fingerprint, correlationId) {
  if (!a || !a.logSheetId) return;
  try {
    var logSs = SpreadsheetApp.openById(a.logSheetId);
    var sh = logSs.getSheets()[0];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, ASSIST_LOG_HEADERS.length).setValues([ASSIST_LOG_HEADERS.slice()]);
      sh.setFrozenRows(1);
    }
    sh.appendRow([
      new Date(), Util.getActiveUserEmail(), ss.getName() + ' (' + ss.getId() + ')',
      String(question || ''), String(answer || '').substring(0, ASSIST_MAX_ANSWER_LOG),
      status, durationMs, findingsIncluded ? 'TRUE' : 'FALSE', fingerprint, correlationId
    ]);
  } catch (e) {
    console.warn('Assist._appendQaLog failed: ' + e.message);
  }
};
