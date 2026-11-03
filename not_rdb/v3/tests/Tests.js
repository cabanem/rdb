

function runTests() {
  var cases = [];
  function t(name, fn) { cases.push([name, fn]); }

  registerParseTests_(t);
  registerSourceTests_(t);
  registerPayloadTests_(t);
  registerConfigCoercionTests_(t);
  registerMiscTests_(t);
  registerSheetReadTests_(t);
  registerGeminiTests_(t);
  registerExtractorTests_(t);
  registerVertexIdentityTests_(t);
  registerSnapshotTests_(t);
  registerUploadTests_(t);
  registerConfigToolsTests_(t);
  registerSchemaTests_(t);
  registerGateTests_(t);
  registerReviewSheetTests_(t);
  registerOpportunityAnchorTests_(t);
  registerBlankPhraseAndErrorTests_(t);

  var pass = 0, fail = 0, skip = 0, lines = [];
  cases.forEach(function (c) {
    try {
      var r = c[1]();
      if (r === 'SKIP') { skip++; lines.push('SKIP  ' + c[0]); }
      else { pass++; lines.push('ok    ' + c[0]); }
    } catch (e) {
      fail++; lines.push('FAIL  ' + c[0] + '\n        ' + e.message);
    }
  });
  var summary = pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped';
  Logger.log(lines.join('\n') + '\n\n' + summary);
  return summary;
}

// --- ASSERTIONS -----------------------------------------------------------------------------------
function assert_(cond, msg) { if (!cond) throw new Error('assert failed: ' + (msg || '')); }

function assertEq_(actual, expected, msg) {
  if (__stable(actual) !== __stable(expected)) {
    throw new Error((msg ? msg + ' — ' : '') +
      'expected ' + __stable(expected) + ', got ' + __stable(actual));
  }
}

function assertThrows_(fn, includes, msg) {
  var threw = false, m = '';
  try { fn(); } catch (e) { threw = true; m = e.message; }
  if (!threw) throw new Error((msg || '') + ' expected a throw, got none');
  if (includes && m.toLowerCase().indexOf(includes.toLowerCase()) === -1) {
    throw new Error((msg || '') + ' threw "' + m + '", expected to include "' + includes + '"');
  }
}

function __stable(v) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return '[' + v.map(__stable).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + __stable(v[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(v);
}

// --- parseResult_ ---------------------------------------------------------------------------------
function registerParseTests_(t) {
  t('parse: clean labels in order', function () {
    var text = '[[Party]]\nAcme\n[[Amount]]\n$100\n[[Term]]\n12 months';
    var out = parseResult_(text, ['Party', 'Amount', 'Term']);
    assertEq_(out, { Party: 'Acme', Amount: '$100', Term: '12 months' });
  });

  t('parse: labels out of config order still map correctly', function () {
    var text = '[[Term]]\n12 months\n[[Party]]\nAcme';
    var out = parseResult_(text, ['Party', 'Term']);
    assertEq_(out, { Party: 'Acme', Term: '12 months' });
  });

  t('parse: missing field becomes blank', function () {
    var text = '[[Party]]\nAcme\n[[Term]]\n12 months';
    var out = parseResult_(text, ['Party', 'Amount', 'Term']);
    assertEq_(out.Amount, '');
  });

  t('parse: tolerates markdown noise around labels', function () {
    var text = '## [[Party]]:\nAcme Corp\n**[[Amount]]**\n$500';
    var out = parseResult_(text, ['Party', 'Amount']);
    assertEq_(out, { Party: 'Acme Corp', Amount: '$500' });
  });

  t('parse: field name with regex-special chars', function () {
    var out = parseResult_('[[Amount ($)]]\n500', ['Amount ($)']);
    assertEq_(out['Amount ($)'], '500');
  });

  t('parse: no markers -> whole body lands in field[0] (never lose text)', function () {
    var out = parseResult_('free text, model ignored the format', ['Party', 'Amount']);
    assertEq_(out.Party, 'free text, model ignored the format');
    assertEq_(out.Amount, '');
  });

  t('parse: multi-line content captured and trimmed', function () {
    var text = '[[Party]]\n  Acme Corp\nSubsidiary of X  \n[[Term]]\n12 months';
    var out = parseResult_(text, ['Party', 'Term']);
    assertEq_(out.Party, 'Acme Corp\nSubsidiary of X');
  });

  t('parse: empty text -> all blank', function () {
    var out = parseResult_('', ['Party', 'Amount']);
    assertEq_(out, { Party: '', Amount: '' });
  });
}

// --- extractSources_ ------------------------------------------------------------------------------
function registerSourceTests_(t) {
  t('sources: null meta -> empty', function () { assertEq_(extractSources_(null), ''); });
  t('sources: no chunks -> empty', function () { assertEq_(extractSources_({}), ''); });

  t('sources: title and uri formatted', function () {
    var meta = { groundingChunks: [{ web: { uri: 'http://a', title: 'Site A' } }] };
    assertEq_(extractSources_(meta), 'Site A — http://a');
  });

  t('sources: duplicate uris deduped', function () {
    var meta = {
      groundingChunks: [
        { web: { uri: 'http://a', title: 'A' } },
        { web: { uri: 'http://a', title: 'A again' } }
      ]
    };
    assertEq_(extractSources_(meta), 'A — http://a');
  });

  t('sources: missing title falls back to uri; chunk without web skipped', function () {
    var meta = {
      groundingChunks: [
        { web: { uri: 'http://b' } },
        { somethingElse: true }
      ]
    };
    assertEq_(extractSources_(meta), 'http://b — http://b');
  });
}

// --- buildPayload_ --------------------------------------------------------------------------------
function registerPayloadTests_(t) {
  t('payload: shape, approved-vs-extracted split, correlation passthrough, snake_case wire keys', function () {
    var approval = {
      correlationId: 'corr-9', fileId: 'FID', fileName: 'c.pdf',
      model: 'gemini-2.5-pro', extractedAt: '2026-01-01T00:00:00.000Z',
      fields: { 'Party': 'Acme Corp', 'Countries where services': 'US, CA' },   // human-approved truth
      extracted: { 'Party': 'Acme', 'Countries where services': 'US' }        // original
    };
    var p = buildPayload_(approval, {});
    assertEq_(p.correlation_id, 'corr-9');
    assertEq_(p.fields.party, 'Acme Corp');
    assertEq_(p.fields.countries_where_services, 'US, CA', 'labels become snake_case keys');
    assertEq_(p.provenance.extracted.party, 'Acme');
    assertEq_(p.provenance.extracted.countries_where_services, 'US');
    assert_(!('Party' in p.fields), 'human label must not leak onto the wire');
    assertEq_(p.source.file_id, 'FID');
    assert_(p.source.drive_url.indexOf('FID') !== -1, 'drive_url should embed file id');
  });
  t('toSnake_: lowercase, non-alphanumerics collapse to _, edges trimmed', function () {
    assertEq_(toSnake_('Total Contract Value'), 'total_contract_value');
    assertEq_(toSnake_('Auto-Renewal'), 'auto_renewal');
    assertEq_(toSnake_('  Amount ($)  '), 'amount');
  });
}

// --- CONFIG COERCION ------------------------------------------------------------------------------
function registerConfigCoercionTests_(t) {
  t('parseList_: newline-separated', function () {
    assertEq_(parseList_('A\nB\nC'), ['A', 'B', 'C']);
  });
  t('parseList_: comma-separated, trimmed, blanks dropped', function () {
    assertEq_(parseList_(' A , B ,,\nC '), ['A', 'B', 'C']);
  });
  t('parseList_: empty -> []', function () { assertEq_(parseList_(''), []); });

  t('asBool_: truthy strings and booleans', function () {
    ['true', 'TRUE', 'yes', '1'].forEach(function (v) { assert_(asBool_(v) === true, v); });
    ['false', 'no', '0', ''].forEach(function (v) { assert_(asBool_(v) === false, v); });
    assert_(asBool_(true) === true && asBool_(false) === false, 'native bools');
  });

  t('isFilled_: zero is filled, empty/null/undefined are not', function () {
    assert_(isFilled_(0) === true, 'temperature 0 must be respected');
    assert_(isFilled_('') === false && isFilled_(null) === false && isFilled_(undefined) === false);
  });

  t('str_: trims, stringifies, null -> empty', function () {
    assertEq_(str_('  x '), 'x');
    assertEq_(str_(5), '5');
    assertEq_(str_(null), '');
  });
}

// --- MISC HELPERS ---------------------------------------------------------------------------------
function registerMiscTests_(t) {
  t('fieldInstruction_: contains each label in order', function () {
    var s = fieldInstruction_(['Party', 'Amount']);
    assert_(s.indexOf('[[Party]]') < s.indexOf('[[Amount]]'), 'order preserved');
    assert_(s.indexOf('[[ ]]') === -1 || s.indexOf('except as these labels') !== -1, 'guard present');
  });
  t('escapeRegex_: escapes specials', function () {
    assertEq_(escapeRegex_('a.b($)'), 'a\\.b\\(\\$\\)');
  });
  t('nextAction_: cancel beats approve; otherwise push or wait', function () {
    assertEq_(nextAction_({ cancelled: true, approved: true }), 'cancel');
    assertEq_(nextAction_({ cancelled: true, approved: false }), 'cancel');
    assertEq_(nextAction_({ cancelled: false, approved: true }), 'push');
    assertEq_(nextAction_({ cancelled: false, approved: false }), 'wait');
  })
}

// --- SHEET READBACK -------------------------------------------------------------------------------
function registerSheetReadTests_(t) {
  t('readApproval_: unchecked box, fields read in grid order', function () {
    var ss = fakeReviewSpreadsheet_(false, true);
    var a = readApproval_(ss);
    assertEq_(a.approved, false);
    assertEq_(a.correlationId, 'corr-1');
    assertEq_(a.fileId, 'FILE123');
    assertEq_(a.fileName, 'contract.pdf');
    assertEq_(a.fields, { Party: 'Acme Corp', Amount: '$100', Term: '24 months' });
    assertEq_(a.extracted, { Party: 'Acme', Amount: '$100', Term: '12 months' });
    assertEq_(a.status, 'Pending Review');
    assertEq_(a.lastError, '', 'no Last Error row -> empty string');
  });

  // Approved
  t('readApproval_: checked box -> approved true', function () {
    assertEq_(readApproval_(fakeReviewSpreadsheet_(true, true)).approved, true);
  });

  t('readApproval_: grid stops at Sources sentinel when no blank separator', function () {
    var a = readApproval_(fakeReviewSpreadsheet_(false, false));
    assertEq_(a.fields, { Party: 'Acme Corp', Amount: '$100', Term: '24 months' });
  });

  // Missing tab
  t('readApproval_: falls back to sheet[0] when named tab absent', function () {
    // nameMap empty -> getSheetByName returns null -> getSheets()[0] used.
    var sheet = makeFakeSheet_(reviewGrid_(false, true));
    var ss = { getSheetByName: function () { return null; }, getSheets: function () { return [sheet]; } };
    assertEq_(readApproval_(ss).fileId, 'FILE123');
  });

  // Cancelled
  t('readApproval_: Cancel? unticked => cancelled false', function () {
    assertEq_(readApproval_(fakeReviewSpreadsheet_(false, true)).cancelled, false);
  });
  t('readApproval_: Cancel? ticked => cancelled true', function () {
    assertEq_(readApproval_(fakeReviewSpreadsheet_(false, true, true)).cancelled, true);
    assertEq_(readApproval_(fakeReviewSpreadsheet_(false, true, false)).cancelled, false);
  });

  t('readApproval_: a sheet created with the OLD Title Case labels still reads correctly', function () {
    var a = readApproval_(makeFakeSpreadsheet_(makeFakeSheet_(legacyReviewGrid_()), {}));
    assertEq_(a.fileId, 'FILE123');
    assertEq_(a.approved, true);
    assertEq_(a.extractedAt, '2026-01-01T00:00:00.000Z');
    assert_(!('Grounding Sources' in a.fields), 'legacy Sources row must still end the grid');
    assertEq_(Object.keys(a.fields).length, 3);
  });

  t('readMeta_: returns blank for an unknown label', function () {
    var sheet = makeFakeSheet_(reviewGrid_(false, true));
    assertEq_(readMeta_(sheet, 'No Such Label'), '');
  });
}

/** A faithful in-memory copy of what createReviewSheet_ writes, built from the same constants so it cannot drift. */
function reviewGrid_(approved, withBlankBeforeSources, cancelled) {
  var g = [
    [META.ORIGINAL,    '(hyperlink)',  ''],
    [META.SOURCE_ID,   'FILE123',      ''],
    [META.SOURCE_NAME, 'contract.pdf', ''],
    [META.CORRELATION, 'corr-1',       ''],
    [META.EXTRACTED,   '2026-01-01T00:00:00.000Z', ''],
    [META.MODEL,       'gemini-2.5-pro', ''],
    [META.STATUS,      'Pending Review', ''],
    [META.APPROVED,    approved,       ''],
    [META.CANCEL,      cancelled === true, ''],
    ['', '', ''],
    GRID_HEADER.slice(),
    ['Party',  'Acme',      'Acme Corp'],           // corrected
    ['Amount', '$100',      '$100'],
    ['Term',   '12 months', '24 months']            // corrected
  ];
  if (withBlankBeforeSources) g.push(['', '', '']);
  g.push([META.SOURCES, '(none)', '']);
  return g;
}

/** The same sheet as written BEFORE the labels were sentence-cased — what is sitting in Pending today. */
function legacyReviewGrid_() {
  return reviewGrid_(true, true, false).map(function (r) {
    var l = String(r[0]);
    return [l.replace('Source file ID', 'Source File ID').replace('Source file name', 'Source File Name')
             .replace('Extracted at', 'Extracted At').replace('Grounding sources', 'Grounding Sources')
             .replace('Original file', 'Original File'), r[1], r[2]];
  });
}

function fakeReviewSpreadsheet_(approved, withBlankBeforeSources, cancelled) {
  var sheet = makeFakeSheet_(reviewGrid_(approved, withBlankBeforeSources, cancelled));
  return makeFakeSpreadsheet_(sheet, { Review: sheet });
}

/** Minimal fake of the Sheet surface readApproval_/readMeta_ actually call. */
function makeFakeSheet_(grid) {
  return {
    _g: grid,
    getLastRow: function () { return this._g.length; },
    getLastColumn: function () {
      return this._g.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    },
    getDataRange: function () {
      var g = this._g;
      return { getValues: function () { return g.map(function (r) { return r.slice(); }); } };
    },
    getRange: function (row, col, numRows, numCols) {
      var g = this._g;
      return {
        getValues: function () {
          var out = [];
          for (var r = row - 1; r < row - 1 + numRows; r++) {
            var src = g[r] || [], line = [];
            for (var c = col - 1; c < col - 1 + numCols; c++) {
              line.push(src[c] === undefined ? '' : src[c]);
            }
            out.push(line);
          }
          return out;
        }
      };
    }
  };
}

function makeFakeSpreadsheet_(sheet, nameMap) {
  return {
    getSheetByName: function (n) { return (nameMap && nameMap[n]) || null; },
    getSheets: function () { return [sheet]; }
  };
}

// --- GEMINI BRANCH LOGIC --------------------------------------------------------------------------
function registerGeminiTests_(t) {
  var has = (typeof interpretGeminiResponse_ === 'function');
  function skipIfAbsent() { return has ? null : 'SKIP'; }

  t('gemini: non-200 throws with code', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () { interpretGeminiResponse_(500, { error: { message: 'boom' } }, false); }, '500');
  });
  t('gemini: no candidates throws', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () { interpretGeminiResponse_(200, { candidates: [] }, false); }, 'candidates');
  });
  t('gemini: SAFETY throws (no poison success)', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretGeminiResponse_(200, { candidates: [{ finishReason: 'SAFETY' }] }, false);
    }, 'safety');
  });
  t('gemini: RECITATION throws', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretGeminiResponse_(200, { candidates: [{ finishReason: 'RECITATION' }] }, false);
    }, 'recitation');
  });
  t('gemini: empty text throws', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretGeminiResponse_(200, { candidates: [{ content: { parts: [{ text: '' }] } }] }, false);
    }, 'empty');
  });
  t('gemini: happy path returns text + empty sources', function () {
    if (!has) return 'SKIP';
    var r = interpretGeminiResponse_(200, { candidates: [{ content: { parts: [{ text: 'hello' }] } }] }, false);
    assertEq_(r.text, 'hello');
    assertEq_(r.sources, '');
  });
  t('gemini: grounded response surfaces sources', function () {
    if (!has) return 'SKIP';
    var json = {
      candidates: [{
        content: { parts: [{ text: 'answer' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'http://x', title: 'X' } }] }
      }]
    };
    assertEq_(interpretGeminiResponse_(200, json, false).sources, 'X — http://x');
  });
}

// --- EXTRACTOR SEAM (pure, fake model) ------------------------------------------------------------
/**
 * A fake Extractor that records what it was asked and answers with canned model text.
 * @param {string|Error} reply Model text to return, or an Error to throw (a blocked/empty outcome).
 * @param {string} [sources]
 * @return {{extractor:Extractor, calls:Array<{cfg:Object, prompt:string, parts:Array}>}}
 */
function fakeExtractor_(reply, sources) {
  var calls = [];
  return {
    calls: calls,
    extractor: {
      extract: function (cfg, prompt, parts) {
        calls.push({ cfg: cfg, prompt: prompt, parts: parts });
        if (reply instanceof Error) throw reply;
        return { text: reply, sources: sources || '', debug: '' };
      }
    }
  };
}

function registerExtractorTests_(t) {
  var has = (typeof extractFields_ === 'function');
  var cfg = {
    prompt_template: 'Read the contract.',
    output_fields: ['Contract Name', 'Type of contract', 'Contract Start Date'],
    field_keys: { 'Type of contract': 'type_of_contract' }
  };
  var parts = [{ text: 'THIS AGREEMENT is made between Acme and Globex on 2026-01-01.' }];
  var modelText = '[[Contract Name]]\nAcme MSA\n\n[[Type of contract]]\nMSA\n\n[[Contract Start Date]]\n2026-01-01\n';

  t('extractor: asked once, with template + field instruction, parts and cfg passed through untouched', function () {
    if (!has) return 'SKIP';
    var f = fakeExtractor_(modelText);
    extractFields_(parts, cfg, f.extractor);
    assertEq_(f.calls.length, 1);
    var c = f.calls[0];
    assert_(c.prompt.indexOf('Read the contract.') === 0, 'prompt starts with the template');
    assert_(c.prompt.indexOf('[[Contract Name]]\n[[Type of contract]]\n[[Contract Start Date]]') !== -1, 'labels listed in config order');
    assert_(c.parts === parts, 'content parts passed through by reference');
    assert_(c.cfg === cfg, 'config passed through');
  });

  t('extractor: model text becomes a label -> text map; sources ride along', function () {
    if (!has) return 'SKIP';
    var r = extractFields_(parts, cfg, fakeExtractor_(modelText, 'Acme — http://acme').extractor);
    assertEq_(r.parsed, { 'Contract Name': 'Acme MSA', 'Type of contract': 'MSA', 'Contract Start Date': '2026-01-01' });
    assertEq_(r.sources, 'Acme — http://acme');
    assertEq_(r.debug, '');
  });

  t('extractor: a field the model skipped is present and blank', function () {
    if (!has) return 'SKIP';
    var r = extractFields_(parts, cfg, fakeExtractor_('[[Contract Name]]\nAcme MSA').extractor);
    assertEq_(r.parsed['Contract Name'], 'Acme MSA');
    assertEq_(r.parsed['Type of contract'], '');
    assertEq_(r.parsed['Contract Start Date'], '');
  });

  t('extractor: a blocked or empty model outcome propagates unchanged (no poison success)', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      extractFields_(parts, cfg, fakeExtractor_(new Error('Gemini blocked: safety.')).extractor);
    }, 'safety');
  });

  t('extractor: model text -> review-sheet plan, end to end without a sheet', function () {
    if (!has || typeof planApprovedCells_ !== 'function') return 'SKIP';
    var schema = {
      type_of_contract: { key: 'type_of_contract', name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist',
        length: 255, scale: 0, precision: 0, controller: null,
        values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] }] },
      contract_start_date: { key: 'contract_start_date', name: 'StartDate', label: 'Contract Start Date', type: 'date',
        length: 0, scale: 0, precision: 0, controller: null, values: null }
    };
    var r = extractFields_(parts, cfg, fakeExtractor_(modelText).extractor);
    var plan = planApprovedCells_(cfg, schema, cfg.output_fields, r.parsed);
    assertEq_(plan.map(function (p) { return p.label; }), cfg.output_fields, 'rows in config order');
    assertEq_(plan[0].seed, 'Acme MSA');                       // no schema entry: model text, no rule
    assertEq_(plan[0].rule, null);
    assertEq_(plan[1].seed, 'Master Services Agreement');      // picklist: value "MSA" seeded as its label
    assertEq_(plan[1].rule.kind, 'list');
    assert_(plan[2].seed instanceof Date, 'date cell seeded as a Date');
    assertEq_(plan[2].flagged, false);
  });

  t('extractor: the default is the Vertex adapter', function () {
    if (typeof vertexExtractor_ !== 'function') return 'SKIP';
    var e = vertexExtractor_();
    assertEq_(typeof e.extract, 'function');
    assert_(e.extract === callGemini_, 'vertexExtractor_().extract is callGemini_');
  });
}

// --- VERTEX IDENTITY (pure) -----------------------------------------------------------------------
function registerVertexIdentityTests_(t) {
  var has = (typeof vertexIdentity_ === 'function' && typeof interpretMintResponse_ === 'function');

  t('identity: blank Config key -> the runner; an email -> that service account', function () {
    if (!has) return 'SKIP';
    assertEq_(vertexIdentity_({}), { mode: 'runner' });
    assertEq_(vertexIdentity_({ vertex_service_account: '' }), { mode: 'runner' });
    assertEq_(vertexIdentity_({ vertex_service_account: '  g2s@proj.iam.gserviceaccount.com ' }),
      { mode: 'service_account', email: 'g2s@proj.iam.gserviceaccount.com' });
  });

  t('identity: parseConfig_ carries vertex_service_account through, blank by default', function () {
    if (typeof parseConfig_ !== 'function') return 'SKIP';
    var raw = {
      folder_id_ingestion: 'a', folder_id_processed: 'b', folder_id_failed: 'c', folder_id_pending: 'd',
      folder_id_pushed: 'e', folder_id_cancelled: 'f', prompt_template: 'p', project_id: 'proj',
      workato_webhook_url: 'https://w', output_fields: 'Contract Name'
    };
    assertEq_(parseConfig_(raw).vertex_service_account, '');
    raw.vertex_service_account = ' sa@proj.iam.gserviceaccount.com ';
    assertEq_(parseConfig_(raw).vertex_service_account, 'sa@proj.iam.gserviceaccount.com');
  });

  t('mint: 200 with accessToken returns the token', function () {
    if (!has) return 'SKIP';
    assertEq_(interpretMintResponse_(200, { accessToken: 'ya29.x', expireTime: '2026-01-01T00:10:00Z' }, 'sa@p'), 'ya29.x');
  });

  t('mint: 403 names the service account and the missing role', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () {
      interpretMintResponse_(403, { error: { message: 'Permission iam.serviceAccounts.getAccessToken denied' } }, 'sa@p');
    }, 'sa@p');
    assertThrows_(function () {
      interpretMintResponse_(403, { error: { message: 'denied' } }, 'sa@p');
    }, 'serviceAccountTokenCreator');
  });

  t('mint: 200 without a token is still a failure (no poison success)', function () {
    if (!has) return 'SKIP';
    assertThrows_(function () { interpretMintResponse_(200, {}, 'sa@p'); }, 'no accessToken');
  });
}

// --- SNAPSHOT / DASHBOARD (pure) ------------------------------------------------------------------
function registerSnapshotTests_(t) {
  var approval = {
    approved: false, correlationId: 'corr-7', fileId: 'F', fileName: 'msa.pdf', model: 'm',
    extractedAt: '2026-09-08T13:00:00.000Z', status: 'Pending Review', lastError: '',
    fields: {}, extracted: {}
  };

  t('queueRow_: unticked sheet -> Pending Review row in header order', function () {
    var r = queueRow_('Contract Review: msa.pdf', 'http://sheet', approval);
    assertEq_(r, ['Contract Review: msa.pdf', 'Pending Review', false, '2026-09-08T13:00:00.000Z', '', 'http://sheet', 'corr-7', 'https://drive.google.com/file/d/F/view']);
    assertEq_(r.length, QUEUE_HEADERS.length, 'row width matches header');
  });

  t('queueRow_: push failure this run -> Error, message from this run wins', function () {
    var a = Object.assign({}, approval, { approved: true, status: 'Error', lastError: 'old message' });
    var r = queueRow_('x', 'u', a, 'Workato 502: bad gateway');
    assertEq_(r[1], 'Error');
    assertEq_(r[2], true);
    assertEq_(r[4], 'Workato 502: bad gateway');
  });

  t('queueRow_: sheet that errored on a PREVIOUS run keeps its Status and Last Error', function () {
    var a = Object.assign({}, approval, { status: 'Error', lastError: 'Workato 401' });
    var r = queueRow_('x', 'u', a);
    assertEq_(r[1], 'Error');
    assertEq_(r[4], 'Workato 401');
  });

  t('queueRow_: unopenable sheet -> Unreadable with the error', function () {
    var r = queueRow_('x', 'u', null, 'openById failed');
    assertEq_(r[1], 'Unreadable');
    assertEq_(r[4], 'openById failed');
    assertEq_(r[5], 'u');
    assertEq_(r[7], '');
  });

  t('toIso_: Date, ISO string, junk, blank', function () {
    assertEq_(toIso_(new Date('2026-09-08T13:00:00.000Z')), '2026-09-08T13:00:00.000Z');
    assertEq_(toIso_('2026-09-08T13:00:00.000Z'), '2026-09-08T13:00:00.000Z');
    assertEq_(toIso_('not a date'), null);
    assertEq_(toIso_(''), null);
    assertEq_(toIso_(null), null);
  });

  // A fixed "now" and rows around it. Times are built relative to `now` so the test is timezone-proof.
  var now = new Date(2026, 8, 8, 15, 30, 0);                    // local 15:30
  var todayAt = function (h, m) { return new Date(2026, 8, 8, h, m || 0, 0); };
  var daysAgo = function (d, h) { var x = new Date(2026, 8, 8 - d, h || 12, 0, 0); return x; };
  var logs = [
    [todayAt(9, 0), 'INFO', 'processIngestion', 'c1', 'Staged a.pdf', 'http://s/a'],
    [todayAt(9, 5), 'INFO', 'processIngestion', 'c2', 'Staged b.pdf', 'http://s/b'],
    [todayAt(10, 0), 'INFO', 'processApprovals', 'c1', 'Pushed a.pdf', 'http://s/a'],
    [todayAt(11, 0), 'ERROR', 'processApprovals', 'c2', 'Push failed: b.pdf', 'Workato 502'],
    [daysAgo(1, 16), 'ERROR', 'processIngestion', '', 'Extract failed: z.pdf', 'Vertex 429'],
    [daysAgo(1, 8), 'INFO', 'processApprovals', 'c0', 'Pushed y.pdf', ''],
    [daysAgo(3, 12), 'ERROR', 'processApprovals', '', 'Run failed', 'Config missing'],
    ['garbage', 'ERROR', 'x', '', 'unparseable timestamp', '']
  ];

  t('summarizeLogs_: today counts only today, by message prefix / level', function () {
    var s = summarizeLogs_(logs, now, 2);
    assertEq_(s.today, { staged: 2, pushed: 1, errors: 1 });
  });

  t('summarizeLogs_: errors window is N days, newest first, older ones excluded', function () {
    var s = summarizeLogs_(logs, now, 2);
    assertEq_(s.errors.map(function (e) { return e.message; }),
      ['Push failed: b.pdf', 'Extract failed: z.pdf']);          // the 3-day-old Run failed is out
    assertEq_(s.errors[0].correlationId, 'c2');
    assertEq_(s.errors[0].details, 'Workato 502');
  });

  t('summarizeLogs_: activity is today only, newest first, ISO timestamps', function () {
    var s = summarizeLogs_(logs, now, 2);
    assertEq_(s.activity.map(function (a) { return a.message; }),
      ['Push failed: b.pdf', 'Pushed a.pdf', 'Staged b.pdf', 'Staged a.pdf']);
    assertEq_(s.activity[0].ts, todayAt(11, 0).toISOString());
    assert_(typeof s.activity[0].ts === 'string', 'ts must be a string for google.script.run');
  });

  t('summarizeLogs_: unparseable timestamps are skipped, not fatal', function () {
    var s = summarizeLogs_(logs, now, 30);
    assert_(s.errors.every(function (e) { return e.message !== 'unparseable timestamp'; }));
  });

  t('summarizeLogs_: cap limits list length', function () {
    var s = summarizeLogs_(logs, now, 30, 1);
    assertEq_(s.errors.length, 1);
    assertEq_(s.activity.length, 1);
    assertEq_(s.today.errors, 1, 'counts are not capped');
  });

  t('summarizeLogs_: empty / null input', function () {
    assertEq_(summarizeLogs_([], now, 2), { today: { staged: 0, pushed: 0, errors: 0 }, errors: [], activity: [] });
    assertEq_(summarizeLogs_(null, now, 2).today.staged, 0);
  });
}

// --- UPLOAD (pure) --------------------------------------------------------------------------------
function registerUploadTests_(t) {
  var MAX = 15 * 1024 * 1024;
  var ok = function (name, size) { return validateUpload_({ name: name, size: size == null ? 1000 : size, base64: 'AAAA' }, MAX); };

  t('validateUpload_: MIME comes from the extension, case-insensitive, browser type ignored', function () {
    assertEq_(ok('Contract.PDF').mimeType, 'application/pdf');
    assertEq_(ok('msa.docx').mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assertEq_(ok('old.doc').mimeType, 'application/msword');
  });
  t('validateUpload_: rejects other types with a plain reason', function () {
    var r = ok('rates.xlsx');
    assertEq_(r.ok, false);
    assert_(r.reason.indexOf('PDF') !== -1, 'reason names the accepted types');
    assertEq_(ok('README').ok, false, 'no extension');
    assertEq_(ok('.pdf').ok, false, 'dot-file with no stem is not a pdf name');
  });
  t('validateUpload_: size over the cap is rejected; at the cap is fine', function () {
    assertEq_(ok('a.pdf', MAX).ok, true);
    var r = ok('a.pdf', MAX + 1);
    assertEq_(r.ok, false);
    assert_(r.reason.indexOf('15 MB') !== -1, 'limit stated in MB: ' + r.reason);
  });
  t('validateUpload_: name is sanitised (path separators, trim, length cap)', function () {
    assertEq_(ok('  ..\\..\\evil/name.pdf ').name, '.._.._evil_name.pdf');
    var long = new Array(300).join('x') + '.pdf';
    assert_(ok(long).name.length <= 200, 'capped at 200 chars');
  });
  t('validateUpload_: missing content or name', function () {
    assertEq_(validateUpload_(null, MAX).ok, false);
    assertEq_(validateUpload_({ name: 'a.pdf', size: 1, base64: '' }, MAX).ok, false);
    assertEq_(validateUpload_({ name: '   ', size: 1, base64: 'AA' }, MAX).ok, false);
  });

  t('assertUploadAllowed_: empty list allows anyone, including unknown', function () {
    assertUploadAllowed_('', []);
    assertUploadAllowed_('x@y.com', []);
    assertUploadAllowed_('x@y.com', null);
  });
  t('assertUploadAllowed_: list enforced; unknown visitor refused when a list is set', function () {
    assertUploadAllowed_('ann@corp.com', ['ann@corp.com', 'bo@corp.com']);
    assertThrows_(function () { assertUploadAllowed_('cy@corp.com', ['ann@corp.com']); }, 'upload list');
    assertThrows_(function () { assertUploadAllowed_('', ['ann@corp.com']); }, 'upload list');
  });
  t('mb_: one decimal, trailing .0 dropped', function () {
    assertEq_(mb_(15 * 1024 * 1024), '15');
    assertEq_(mb_(16 * 1024 * 1024 + 512 * 1024), '16.5');
  });
}

// --- CONFIG TOOLS & ACCESS (pure) -----------------------------------------------------------------
function registerConfigToolsTests_(t) {
  var page = { publisherModels: [
    { name: 'publishers/google/models/gemini-2.5-pro',            versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/gemini-2.5-flash',          versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/gemini-3.0-pro-preview',    versionId: '001', launchStage: 'PUBLIC_PREVIEW' },
    { name: 'publishers/google/models/gemini-1.5-pro',            versionId: '002', launchStage: 'DEPRECATED' },
    { name: 'publishers/google/models/gemini-embedding-001',      versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/gemini-2.5-flash-image',    versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/gemini-2.5-flash-preview-tts', versionId: '001', launchStage: 'PUBLIC_PREVIEW' },
    { name: 'publishers/google/models/gemini-live-2.5-flash',     versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/imagen-4.0-generate-001',   versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/text-embedding-005',        versionId: '001', launchStage: 'GA' },
    { name: 'publishers/google/models/gemini-2.5-pro',            versionId: '001', launchStage: 'GA' }   // duplicate
  ] };

  t('parseModelList_: keeps text-capable Gemini models only, drops deprecated and variants, dedupes', function () {
    var ids = parseModelList_(page).map(function (m) { return m.id; });
    assertEq_(ids, ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.0-pro-preview']);
  });
  t('parseModelList_: GA first, then previews; stage and version carried', function () {
    var out = parseModelList_(page);
    assertEq_(out[0].stage, 'GA');
    assertEq_(out[2].stage, 'PUBLIC_PREVIEW');
    assertEq_(out[0].version, '001');
  });
  t('parseModelList_: empty / malformed pages are harmless', function () {
    assertEq_(parseModelList_(null), []);
    assertEq_(parseModelList_({}), []);
    assertEq_(parseModelList_({ publisherModels: [{}, { name: null }] }), []);
  });
  t('dedupeModels_: unknown stage sorts last', function () {
    var out = dedupeModels_([{ id: 'b', stage: 'UNKNOWN', version: '' }, { id: 'a', stage: 'GA', version: '' }]);
    assertEq_(out.map(function (m) { return m.id; }), ['a', 'b']);
  });

  t('pickerConfig_: presence of picker_url is the switch', function () {
    assertEq_(pickerConfig_({ picker_url: '' }), null);
    var p = pickerConfig_({ picker_url: 'https://script.google.com/a/macros/x/s/ID/exec' });
    assertEq_(p.url, 'https://script.google.com/a/macros/x/s/ID/exec');
    assert_(p.mimeTypes.indexOf('application/pdf') !== -1, 'mime list carried');
  });

  t('classifyError_: the messages a visitor without access actually sees', function () {
    assertEq_(classifyError_('Exception: You do not have permission to access the requested document.'), 'permission');
    assertEq_(classifyError_('ScriptError: Authorization is required to perform that action.'), 'authorization');
    assertEq_(classifyError_('Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp.'), 'missing');
    assertEq_(classifyError_('Config missing required key: folder_id_cancelled'), 'missing');
    assertEq_(classifyError_("We're sorry, a server error occurred. Please wait a bit and try again."), 'transient');
    assertEq_(classifyError_('Service invoked too many times for one day: urlfetch'), 'transient');
    assertEq_(classifyError_('something odd'), 'other');
    assertEq_(classifyError_(undefined), 'other');
  });
}

// --- INTEGRATION HELPERS --------------------------------------------------------------------------
/**
 * Extract one real file into the pending folder so you can eyeball the review
 * sheet immediately. Costs one Vertex call and writes a real sheet. Does NOT
 * move the original, so it's repeatable (each run leaves another review sheet).
 */
function INTEGRATION_dryRunOneFile() {
  var FILE_ID = 'PUT_A_REAL_INGESTION_FILE_ID';
  var cfg = readConfig_();
  var sheet = extractOneFile_(DriveApp.getFileById(FILE_ID), cfg,
    DriveApp.getFolderById(cfg.folder_id_pending));
  Logger.log('Review sheet created: ' + sheet.url);
}

/**
 * Push one real review sheet to Workato regardless of its checkbox. This really
 * hits the webhook (and Salesforce) — point workato_webhook_url at a TEST recipe,
 * or rely on the correlation_id upsert to keep repeats from duplicating records.
 * Does not mark/move the sheet, so it's repeatable.
 */
function INTEGRATION_pushOneSheet() {
  var SHEET_ID = 'PUT_A_REAL_REVIEW_SHEET_ID';
  var cfg = readConfig_();
  var approval = readApproval_(SpreadsheetApp.openById(SHEET_ID));
  approval.approved = true;                       // force, to exercise the POST
  var gate = validateApproval_(approval, cfg, loadSchema_());
  if (!gate.ok) throw new Error(gate.message);
  pushToWorkato_(approval, cfg, gate.fields);
  Logger.log('Pushed correlation_id ' + approval.correlationId);
}

/**
 * Schema.gs and output_fields alias tests. Pure layer only: parseOutputFields_, wireKey_, rekey_,
 * interpretSchemaResponse_, schemaRows_, reconcileSchema_, schemaFromRows_, schemaFor_, isPicklist_.
 * refreshSchema/fetchSchema_/writeSchemaTab_/loadSchema_ touch the network or the sheet and are exercised from the
 * dashboard's Settings drawer (Refresh now).
 */
function registerSchemaTests_(t) {
  // --- output_fields aliases ---
  t('parseOutputFields_: bare line keys on its own label', function () {
    var r = parseOutputFields_(['Contract name']);
    assertEq_(r.labels, ['Contract name']);
    assertEq_(r.keys, { 'Contract name': 'contract_name' });
  });
  t('parseOutputFields_: "Label => Salesforce label" keeps the label, keys on the target', function () {
    var r = parseOutputFields_(['Countries where services => Countries Supplying Services', 'System down notice (hours)=>System Down Notification Time Fram']);
    assertEq_(r.labels, ['Countries where services', 'System down notice (hours)']);
    assertEq_(r.keys['Countries where services'], 'countries_supplying_services');
    assertEq_(r.keys['System down notice (hours)'], 'system_down_notification_time_fram');
  });
  t('parseOutputFields_: alias and bare label colliding on one key throws', function () {
    assertThrows_(function () { parseOutputFields_(['Payment terms', 'Terms => Payment Terms']); }, 'collide');
  });
  t('parseOutputFields_: blank target throws', function () {
    assertThrows_(function () { parseOutputFields_(['Status =>']); }, 'bad line');
  });
  t('wireKey_/rekey_: alias wins, bare label falls back to toSnake_', function () {
    var cfg = { field_keys: { 'Product lines': 'product_line_s' } };
    assertEq_(wireKey_(cfg, 'Product lines'), 'product_line_s');
    assertEq_(wireKey_(cfg, 'Governing law'), 'governing_law');
    assertEq_(wireKey_({}, 'Governing law'), 'governing_law');
    assertEq_(rekey_({ 'Product lines': 'RPO;MSP', 'Governing law': 'Delaware' }, cfg),
      { product_line_s: 'RPO;MSP', governing_law: 'Delaware' });
  });

  var sample = [
    { name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist', length: 255, scale: 0, precision: 0,
      controller: null, values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] },
                                 { value: 'SOW', label: 'Statement of Work', valid_for: [] }] },
    { name: 'Product_Line_s__c', label: 'Product Line(s)', type: 'multipicklist', length: 4099, scale: 0, precision: 4,
      controller: null, values: [{ value: 'RPO', label: 'RPO', valid_for: [] }] },
    { name: 'Late_Charge__c', label: 'Late Charge', type: 'percent', length: 0, scale: 1, precision: 2, controller: null, values: null },
    { name: 'Name', label: 'Contract Name', type: 'string', length: 80, scale: 0, precision: 0, controller: null, values: null },
    { name: 'Countries_Supplying_Services__c', label: 'Countries Supplying Services', type: 'multipicklist', length: 4099,
      scale: 0, precision: 5, controller: 'Geographical_Scope__c',
      values: [{ value: 'Canada', label: 'Canada', valid_for: ['North America'] }] }
  ];

  // --- interpretSchemaResponse_ ---
  t('schema: 200 with fields returns the array', function () {
    assertEq_(interpretSchemaResponse_(200, { ok: true, fields: sample }).length, 5);
  });
  t('schema: non-200 throws with the message', function () {
    assertThrows_(function () { interpretSchemaResponse_(400, { ok: false, message: 'Nothing returned' }); }, 'Nothing returned');
  });
  t('schema: ok:false throws even on 200', function () {
    assertThrows_(function () { interpretSchemaResponse_(200, { ok: false, message: 'nope' }); }, 'nope');
  });
  t('schema: empty fields throws (never overwrite with nothing)', function () {
    assertThrows_(function () { interpretSchemaResponse_(200, { ok: true, fields: [] }); }, 'no fields');
  });

  // --- schemaRows_ ---
  t('schemaRows_: key is toSnake_(label), parentheses included', function () {
    var r = schemaRows_(sample);
    assertEq_(r.rows.map(function (x) { return x[0]; }),
      ['type_of_contract', 'product_line_s', 'late_charge', 'contract_name', 'countries_supplying_services']);
    assertEq_(r.collisions, []);
  });
  t('schemaRows_: non-picklist has blank Values; picklist has JSON', function () {
    var r = schemaRows_(sample);
    assertEq_(r.rows[2][8], '');
    assertEq_(JSON.parse(r.rows[0][8])[1].value, 'SOW');
  });
  t('schemaRows_: numeric columns are numbers, controller is a string', function () {
    var r = schemaRows_(sample);
    assertEq_(r.rows[2].slice(4, 7), [0, 1, 2]);
    assertEq_(r.rows[4][7], 'Geographical_Scope__c');
    assertEq_(r.rows[0][7], '');
  });
  t('schemaRows_: duplicate key keeps first and reports the collision', function () {
    var r = schemaRows_([
      { name: 'A__c', label: 'Payment Terms', type: 'string' },
      { name: 'B__c', label: 'Payment terms', type: 'string' }
    ]);
    assertEq_(r.rows.length, 1);
    assertEq_(r.rows[0][1], 'A__c');
    assert_(r.collisions[0].indexOf('payment_terms') === 0, 'collision names the key');
  });
  t('schemaRows_: fields without name or label are skipped', function () {
    assertEq_(schemaRows_([{ name: 'X__c' }, { label: 'Y' }, null]).rows.length, 0);
  });

  // --- reconcileSchema_ ---
  t('reconcileSchema_: both directions', function () {
    var rec = reconcileSchema_(['type_of_contract', 'late_charge'], ['Type of contract', 'Governing law']);
    assertEq_(rec.unmatchedConfig, ['Governing law']);
    assertEq_(rec.unmatchedSf, ['late_charge']);
  });
  t('reconcileSchema_: an aliased label joins through keyOf', function () {
    var cfg = { field_keys: { 'Countries where services': 'countries_supplying_services' } };
    var rec = reconcileSchema_(['countries_supplying_services'], ['Countries where services'],
      function (l) { return wireKey_(cfg, l); });
    assertEq_(rec.unmatchedConfig, []);
    assertEq_(rec.unmatchedSf, []);
  });

  // --- schemaFromRows_ round trip ---
  t('schemaFromRows_: round-trips schemaRows_ through a fake tab', function () {
    var rows = schemaRows_(sample).rows;
    var tab = [
      ['Fetched at', '2026-10-15T12:00:00.000Z'], ['Config labels not in Salesforce', ''],
      ['Salesforce fields not in Config', ''], ['', ''], SCHEMA_HEADERS
    ].concat(rows);
    var s = schemaFromRows_(tab);
    assertEq_(Object.keys(s).length, 5);
    assertEq_(s.type_of_contract.values[0].label, 'Master Services Agreement');
    assertEq_(s.late_charge.values, null);
    assertEq_(s.late_charge.scale, 1);
    assertEq_(s.countries_supplying_services.controller, 'Geographical_Scope__c');
    assertEq_(s.countries_supplying_services.values[0].valid_for, ['North America']);
  });
  t('schemaFromRows_: no header row -> {}', function () {
    assertEq_(schemaFromRows_([['Fetched at', 'x'], ['', '']]), {});
  });
  t('schemaFromRows_: bad Values JSON -> empty list, not a throw', function () {
    var s = schemaFromRows_([SCHEMA_HEADERS, ['k', 'K__c', 'K', 'picklist', 0, 0, 0, '', '{not json']]);
    assertEq_(s.k.values, []);
  });

  // --- lookup ---
  t('schemaFor_/isPicklist_: joins on the Config label (any case) or its alias', function () {
    var s = schemaFromRows_([SCHEMA_HEADERS].concat(schemaRows_(sample).rows));
    var cfg = { field_keys: { 'Product lines': 'product_line_s' } };
    assert_(schemaFor_(s, cfg, 'Type of contract') !== null, 'case-insensitive join');
    assertEq_(schemaFor_(s, cfg, 'Product lines').name, 'Product_Line_s__c');
    assertEq_(schemaFor_(s, cfg, 'Not a field'), null);
    assert_(isPicklist_(schemaFor_(s, cfg, 'Type of contract')), 'picklist');
    assert_(!isPicklist_(schemaFor_(s, cfg, 'Late charge')), 'percent is not a picklist');
    assert_(!isPicklist_(null), 'null-safe');
  });
}

/**
 * Gate.gs tests. Pure layer: normalizeValue_ per Salesforce type, multipicklist join, dependent picklists,
 * validateApproval_ aggregation and the empty-schema pass-through, workatoErrorText_.
 */
function registerGateTests_(t) {
  var F = {
    pick:  { key: 'type_of_contract', name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist', length: 255, scale: 0, precision: 0, controller: null,
             values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] }, { value: 'SOW', label: 'Statement of Work', valid_for: [] }] },
    scope: { key: 'geographical_scope', name: 'Geographical_Scope__c', label: 'Geographical Scope', type: 'multipicklist', length: 4099, scale: 0, precision: 5, controller: null,
             values: [{ value: 'NA', label: 'North America', valid_for: [] }, { value: 'EU', label: 'Europe', valid_for: [] }] },
    ctry:  { key: 'countries_supplying_services', name: 'Countries_Supplying_Services__c', label: 'Countries Supplying Services', type: 'multipicklist', length: 4099, scale: 0, precision: 5,
             controller: 'Geographical_Scope__c',
             values: [{ value: 'Canada', label: 'Canada', valid_for: ['NA'] }, { value: 'France', label: 'France', valid_for: ['EU'] }, { value: 'Remote', label: 'Remote', valid_for: [] }] },
    bool:  { key: 'exclusivity', name: 'Exclusivity__c', label: 'Exclusivity', type: 'boolean', length: 0, scale: 0, precision: 0, controller: null, values: null },
    date:  { key: 'contract_start_date', name: 'StartDate', label: 'Contract Start Date', type: 'date', length: 0, scale: 0, precision: 0, controller: null, values: null },
    days:  { key: 'termination_clause_days', name: 'Termination_Clause_days__c', label: 'Termination Clause (days)', type: 'double', length: 0, scale: 0, precision: 3, controller: null, values: null },
    pct:   { key: 'late_charge', name: 'Late_Charge__c', label: 'Late Charge', type: 'percent', length: 0, scale: 1, precision: 2, controller: null, values: null },
    name:  { key: 'contract_name', name: 'Name', label: 'Contract Name', type: 'string', length: 80, scale: 0, precision: 0, controller: null, values: null },
    url:   { key: 'link_to_contract_for_legal_review', name: 'Link_To_Contract__c', label: 'Link to Contract for Legal Review', type: 'url', length: 255, scale: 0, precision: 0, controller: null, values: null },
    ref:   { key: 'account_id', name: 'AccountId', label: 'Account ID', type: 'reference', length: 18, scale: 0, precision: 0, controller: null, values: null }
  };
  var schema = {};
  Object.keys(F).forEach(function (k) { schema[F[k].key] = F[k]; });
  var cfg = { field_keys: { 'Countries where services': 'countries_supplying_services', 'Product lines': 'product_line_s' } };

  // --- blanks and pass-through ---
  t('gate: blank -> null, ok, for any type', function () {
    assertEq_(normalizeValue_(F.pick, ''), { ok: true, value: null, message: '' });
    assertEq_(normalizeValue_(F.date, '   ').value, null);
    assertEq_(normalizeValue_(null, null).value, null);
  });
  t('gate: no field (label did not join) -> trimmed pass-through', function () {
    assertEq_(normalizeValue_(null, '  free text  ').value, 'free text');
    assertEq_(normalizeValue_(null, 42).value, 42);
  });
  t('gate: reference passes through untouched (resolved in the recipe)', function () {
    assertEq_(normalizeValue_(F.ref, ' Acme Corp ').value, 'Acme Corp');
  });

  // --- picklist / multipicklist ---
  t('gate: picklist matches label or value, any case, emits the API value', function () {
    assertEq_(normalizeValue_(F.pick, 'master services agreement').value, 'MSA');
    assertEq_(normalizeValue_(F.pick, ' sow ').value, 'SOW');
  });
  t('gate: picklist rejects unknown and lists options by label', function () {
    var r = normalizeValue_(F.pick, 'Master Service');
    assert_(!r.ok, 'rejected');
    assert_(r.message.indexOf('Master Services Agreement | Statement of Work') !== -1, r.message);
  });
  t('gate: multipicklist splits on ; or newline, dedupes, joins with ;', function () {
    assertEq_(normalizeValue_(F.scope, 'North America; europe\nNA').value, 'NA;EU');
  });
  t('gate: multipicklist names every bad part', function () {
    var r = normalizeValue_(F.scope, 'North America; Asia; Mars');
    assert_(!r.ok, 'rejected');
    assert_(r.message.indexOf('"Asia; Mars" are not options') === 0, r.message);
  });
  t('gate: multipicklist of only blanks -> null', function () {
    assertEq_(normalizeValue_(F.scope, ' ; ').value, null);
  });

  // --- boolean ---
  t('gate: boolean spellings and real booleans', function () {
    assertEq_(normalizeValue_(F.bool, 'Yes').value, true);
    assertEq_(normalizeValue_(F.bool, 'no').value, false);
    assertEq_(normalizeValue_(F.bool, true).value, true);
    assertEq_(normalizeValue_(F.bool, 'x').value, true);
    assert_(!normalizeValue_(F.bool, 'maybe').ok, 'maybe rejected');
  });

  // --- dates ---
  t('gate: ISO date string passes through without re-parsing', function () {
    assertEq_(normalizeValue_(F.date, '2026-01-01').value, '2026-01-01');
  });
  t('gate: Date cell -> yyyy-MM-dd in the script time zone', function () {
    var r = normalizeValue_(F.date, new Date(2026, 0, 1));   // local midnight, as a Sheets date cell is
    assertEq_(r.value, '2026-01-01');
  });
  t('gate: natural-language date parses; nonsense fails', function () {
    assertEq_(normalizeValue_(F.date, 'January 1, 2026').value, '2026-01-01');
    assert_(!normalizeValue_(F.date, 'next spring').ok, 'rejected');
  });

  // --- numbers ---
  t('gate: double takes the leading number and rounds to scale', function () {
    assertEq_(normalizeValue_(F.days, '90 days').value, 90);
    assertEq_(normalizeValue_(F.days, 60).value, 60);
    assertEq_(normalizeValue_(F.days, '90.6 days').value, 91);
    assert_(!normalizeValue_(F.days, 'ninety').ok, 'words rejected');
  });
  t('gate: percent strips % and keeps one decimal', function () {
    assertEq_(normalizeValue_(F.pct, '1.5%').value, 1.5);
    assertEq_(normalizeValue_(F.pct, '1.55 %').value, 1.6);
    assert_(!normalizeValue_(F.pct, 'n/a').ok, 'n/a is not 0');
  });

  // --- text / url ---
  t('gate: text enforces length', function () {
    assertEq_(normalizeValue_(F.name, ' Acme MSA ').value, 'Acme MSA');
    var long = new Array(82).join('x');
    var r = normalizeValue_(F.name, long);
    assert_(!r.ok && r.message.indexOf('81 characters') === 0, r.message);
  });
  t('gate: url needs a scheme', function () {
    assertEq_(normalizeValue_(F.url, 'https://drive.google.com/file/d/x/view').value, 'https://drive.google.com/file/d/x/view');
    assert_(!normalizeValue_(F.url, 'drive.google.com/file/d/x/view').ok, 'rejected');
  });

  // --- whole sheet ---
  t('validateApproval_: types everything, reports nothing when clean', function () {
    var approval = { fields: { 'Type of contract': 'sow', 'Geographical scope': 'Europe', 'Countries where services': 'France', 'Exclusivity': 'yes', 'Termination clause (days)': '30 days', 'Notes': ' free ' } };
    var g = validateApproval_(approval, cfg, schema);
    assert_(g.ok, g.message);
    assertEq_(g.fields, { 'Type of contract': 'SOW', 'Geographical scope': 'EU', 'Countries where services': 'France', 'Exclusivity': true, 'Termination clause (days)': 30, 'Notes': 'free' });
  });
  t('validateApproval_: collects every failure, in sheet order, with labels', function () {
    var approval = { fields: { 'Type of contract': 'Master Service', 'Exclusivity': 'perhaps', 'Contract name': 'ok' } };
    var g = validateApproval_(approval, cfg, schema);
    assert_(!g.ok, 'failed');
    assertEq_(g.errors.length, 2);
    assert_(g.errors[0].indexOf('Type of contract: ') === 0, g.errors[0]);
    assert_(g.errors[1].indexOf('Exclusivity: ') === 0, g.errors[1]);
    assert_(g.message.indexOf('Not sent') === 0, g.message);
    assertEq_(g.fields['Contract name'], 'ok');
  });
  t('validateApproval_: dependent value checked against the controller\'s normalized value', function () {
    var bad = validateApproval_({ fields: { 'Geographical scope': 'north america', 'Countries where services': 'France' } }, cfg, schema);
    assert_(!bad.ok && bad.errors[0].indexOf('not valid when Geographical scope is "NA"') !== -1, bad.errors.join(' | '));
    var blank = validateApproval_({ fields: { 'Geographical scope': '', 'Countries where services': 'Canada' } }, cfg, schema);
    assert_(!blank.ok && blank.errors[0].indexOf('requires Geographical scope to be set') !== -1, blank.errors.join(' | '));
    var free = validateApproval_({ fields: { 'Geographical scope': '', 'Countries where services': 'Remote' } }, cfg, schema);
    assert_(free.ok, 'unrestricted value needs no controller');
  });
  t('validateApproval_: empty schema passes every cell through unchanged', function () {
    var approval = { fields: { 'Type of contract': 'Master Service', 'Exclusivity': 'perhaps', 'When': '2026-01-01' } };
    var g = validateApproval_(approval, cfg, {});
    assert_(g.ok, 'nothing to judge');
    assertEq_(g.fields, approval.fields);
  });
  t('buildPayload_: typed fields win over raw cells; provenance stays raw', function () {
    var approval = { correlationId: 'c', fileId: 'f', fileName: 'n', extractedAt: 'e', model: 'm',
      fields: { 'Type of contract': 'sow' }, extracted: { 'Type of contract': 'Statement of work (maybe)' } };
    var p = buildPayload_(approval, cfg, { 'Type of contract': 'SOW' });
    assertEq_(p.fields.type_of_contract, 'SOW');
    assertEq_(p.provenance.extracted.type_of_contract, 'Statement of work (maybe)');
  });

  // --- error text ---
  t('workatoErrorText_: structured body first, raw body as fallback', function () {
    assertEq_(workatoErrorText_(400, JSON.stringify({ ok: false, field: 'status', message: 'bad value for restricted picklist' })),
      'Workato 400: status — bad value for restricted picklist');
    assertEq_(workatoErrorText_(502, JSON.stringify({ ok: false, message: 'Unexpected error' })), 'Workato 502: Unexpected error');
    assertEq_(workatoErrorText_(500, '<html>boom</html>'), 'Workato 500: <html>boom</html>');
  });
}

/**
 * ReviewSheet.gs tests. Pure layer: planApprovedCells_ / planOneCell_ per Salesforce type, seeding and flagging,
 * and the empty-schema pass-through. applyApprovedPlan_ touches the sheet and is exercised by processIngestion.
 */
function registerReviewSheetTests_(t) {
  var F = {
    pick:  { key: 'type_of_contract', name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist', length: 255, scale: 0, precision: 0, controller: null,
             values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] }, { value: 'SOW', label: 'Statement of Work', valid_for: [] }] },
    scope: { key: 'geographical_scope', name: 'Geographical_Scope__c', label: 'Geographical Scope', type: 'multipicklist', length: 4099, scale: 0, precision: 5, controller: null,
             values: [{ value: 'NA', label: 'North America', valid_for: [] }, { value: 'EU', label: 'Europe', valid_for: [] }] },
    bool:  { key: 'exclusivity', name: 'Exclusivity__c', label: 'Exclusivity', type: 'boolean', length: 0, scale: 0, precision: 0, controller: null, values: null },
    date:  { key: 'contract_start_date', name: 'StartDate', label: 'Contract Start Date', type: 'date', length: 0, scale: 0, precision: 0, controller: null, values: null },
    name:  { key: 'contract_name', name: 'Name', label: 'Contract Name', type: 'string', length: 80, scale: 0, precision: 0, controller: null, values: null },
    days:  { key: 'termination_clause_days', name: 'Termination_Clause_days__c', label: 'Termination Clause (days)', type: 'double', length: 0, scale: 0, precision: 3, controller: null, values: null }
  };
  var schema = {};
  Object.keys(F).forEach(function (k) { schema[F[k].key] = F[k]; });
  var cfg = { field_keys: {} };

  t('plan: no field -> model text, no rule, no flag', function () {
    assertEq_(planOneCell_(null, '  anything '), { seed: 'anything', flagged: false, note: '', rule: null });
  });
  t('plan: picklist match seeds the LABEL and a strict list', function () {
    var p = planOneCell_(F.pick, 'sow');
    assertEq_(p.seed, 'Statement of Work');
    assertEq_(p.flagged, false);
    assertEq_(p.rule, { kind: 'list', options: ['Master Services Agreement', 'Statement of Work'], strict: true });
  });
  t('plan: picklist mismatch seeds blank, flags, keeps the list', function () {
    var p = planOneCell_(F.pick, 'Master Service');
    assertEq_(p.seed, '');
    assertEq_(p.flagged, true);
    assert_(p.note.indexOf('"Master Service" is not an option') !== -1, p.note);
    assertEq_(p.rule.strict, true);
  });
  t('plan: picklist blank is not flagged', function () {
    var p = planOneCell_(F.pick, '');
    assertEq_(p.seed, ''); assertEq_(p.flagged, false); assertEq_(p.rule.kind, 'list');
  });
  t('plan: multipicklist keeps matched labels, drops and flags the rest, advisory list', function () {
    var p = planOneCell_(F.scope, 'north america; Asia');
    assertEq_(p.seed, 'North America');
    assertEq_(p.flagged, true);
    assert_(p.note.indexOf('"Asia" is not an option') !== -1, p.note);
    assertEq_(p.rule.strict, false);
    var clean = planOneCell_(F.scope, 'Europe\nNA');
    assertEq_(clean.seed, 'Europe; North America'); assertEq_(clean.flagged, false);
  });
  t('plan: boolean seeds ticked/unticked; nonsense unticked and flagged', function () {
    assertEq_(planOneCell_(F.bool, 'Yes').seed, true);
    assertEq_(planOneCell_(F.bool, 'no').seed, false);
    assertEq_(planOneCell_(F.bool, '').flagged, false);
    var p = planOneCell_(F.bool, 'perhaps');
    assertEq_(p.seed, false); assertEq_(p.flagged, true); assertEq_(p.rule.kind, 'checkbox');
  });
  t('plan: date seeds a local-midnight Date for ISO text; keeps and flags unparseable text', function () {
    var p = planOneCell_(F.date, '2026-01-01');
    assert_(p.seed instanceof Date, 'Date');
    assertEq_([p.seed.getFullYear(), p.seed.getMonth(), p.seed.getDate()], [2026, 0, 1]);
    assertEq_(p.rule.kind, 'date');
    var bad = planOneCell_(F.date, 'upon signature');
    assertEq_(bad.seed, 'upon signature'); assertEq_(bad.flagged, true);
  });
  t('plan: text/number keep the text and flag only what the gate would reject', function () {
    assertEq_(planOneCell_(F.name, 'Acme MSA').flagged, false);
    var long = planOneCell_(F.name, new Array(90).join('x'));
    assertEq_(long.flagged, true); assert_(long.note.indexOf('characters') !== -1, long.note);
    assertEq_(planOneCell_(F.days, '90 days').flagged, false);
    assertEq_(planOneCell_(F.days, 'ninety').flagged, true);
  });
  t('planApprovedCells_: rows in config order; empty schema is a plain pass-through', function () {
    var labels = ['Type of contract', 'Notes'];
    var data = { 'Type of contract': 'MSA', 'Notes': 'n' };
    var plan = planApprovedCells_(cfg, schema, labels, data);
    assertEq_(plan.map(function (p) { return p.label; }), labels);
    assertEq_(plan[0].seed, 'Master Services Agreement');
    assertEq_(plan[0].extracted, 'MSA');
    assertEq_(plan[1].rule, null);
    var plain = planApprovedCells_(cfg, {}, labels, data);
    assertEq_(plain.map(function (p) { return [p.seed, p.flagged, p.rule]; }), [['MSA', false, null], ['n', false, null]]);
  });
}

/**
 * Opportunity-anchored write path: output_fields roles, the Opportunity cell, required rows, the owner default,
 * the search response, and the schema's required flag. All pure.
 */
function registerOpportunityAnchorTests_(t) {
  // --- output_fields roles ---
  t('parseOutputFields_: [manual] and [info] markers set roles and leave the key alone', function () {
    var r = parseOutputFields_(['Opportunity => Opportunity [manual]', 'Account Name [info]', 'Type of contract']);
    assertEq_(r.labels, ['Opportunity', 'Account Name', 'Type of contract']);
    assertEq_(r.keys.Opportunity, 'opportunity');
    assertEq_(r.keys['Account Name'], 'account_name');
    assertEq_(r.roles, { 'Opportunity': 'manual', 'Account Name': 'info' });
  });
  t('parseOutputFields_: marker is case-insensitive and tolerates spaces', function () {
    assertEq_(parseOutputFields_(['Owner  [ Manual ]']).roles, { Owner: 'manual' });
    assertEq_(parseOutputFields_(['Notes']).roles, {});
  });

  var cfg = parseConfig_({
    folder_id_ingestion: 'a', folder_id_processed: 'b', folder_id_failed: 'c', folder_id_pending: 'd',
    folder_id_pushed: 'e', folder_id_cancelled: 'f', prompt_template: 'p', project_id: 'g', workato_webhook_url: 'u',
    output_fields: 'Opportunity => Opportunity [manual]\nAccount Name [info]\nType of contract\nCountries where services => Countries Supplying Services\nExclusivity\nStart => Contract Start Date',
    required_fields: 'Type of contract, Countries Supplying Services, start',
    opportunity_search_label: 'account name',
    contract_owner_email: 'Owner@Example.com'
  });

  // --- parseConfig_ ---
  t('parseConfig_: required_fields resolve by label or Salesforce label, any case', function () {
    assertEq_(cfg.required_fields, ['Type of contract', 'Countries where services', 'Start']);
    assertEq_(cfg.opportunity_search_label, 'Account Name');
    assertEq_(cfg.contract_owner_email, 'owner@example.com');
  });
  t('parseConfig_: a required_fields entry that matches nothing throws, naming the key', function () {
    assertThrows_(function () {
      parseConfig_({ folder_id_ingestion: 'a', folder_id_processed: 'b', folder_id_failed: 'c', folder_id_pending: 'd',
        folder_id_pushed: 'e', folder_id_cancelled: 'f', prompt_template: 'p', project_id: 'g', workato_webhook_url: 'u',
        output_fields: 'Type of contract', required_fields: 'Typo of contract' });
    }, 'required_fields: "Typo of contract"');
    assertEq_(errorKey_('required_fields: "x" is not one of output_fields'), 'required_fields');
  });
  t('parseConfig_: contract_owner_email must look like an email when set', function () {
    assertThrows_(function () {
      parseConfig_({ folder_id_ingestion: 'a', folder_id_processed: 'b', folder_id_failed: 'c', folder_id_pending: 'd',
        folder_id_pushed: 'e', folder_id_cancelled: 'f', prompt_template: 'p', project_id: 'g', workato_webhook_url: 'u',
        output_fields: 'X', contract_owner_email: 'not an email' });
    }, 'contract_owner_email');
  });
  t('labelsWithRole_/fieldRole_: default role is extract', function () {
    assertEq_(labelsWithRole_(cfg, 'manual'), ['Opportunity']);
    assertEq_(labelsWithRole_(cfg, 'info'), ['Account Name']);
    assertEq_(labelsWithRole_(cfg, 'extract'), ['Type of contract', 'Countries where services', 'Exclusivity', 'Start']);
    assertEq_(fieldRole_(cfg, 'Exclusivity'), 'extract');
  });

  // --- prompt ---
  t('promptLabels_: [manual] rows are not asked of the model; [info] rows are', function () {
    assertEq_(promptLabels_(cfg), ['Account Name', 'Type of contract', 'Countries where services', 'Exclusivity', 'Start']);
  });
  t('extractFields_: a [manual] row comes back blank and is still present', function () {
    if (typeof extractFields_ !== 'function') return 'SKIP';
    var f = fakeExtractor_('[[Account Name]]\nLinker Finance\n[[Type of contract]]\nMSA');
    var r = extractFields_([{ text: 'x' }], cfg, f.extractor);
    assert_(f.calls[0].prompt.indexOf('[[Opportunity]]') === -1, 'Opportunity not in the prompt');
    assertEq_(r.parsed.Opportunity, '');
    assertEq_(r.parsed['Account Name'], 'Linker Finance');
    assertEq_(r.parsed.Exclusivity, '');
  });

  // --- normalizeOpportunity_ ---
  t('normalizeOpportunity_: bare 15, bare 18, Lightning URL, Classic URL, dropdown text; garbage -> null', function () {
    assertEq_(normalizeOpportunity_('006Ro00000ABCDE'), '006Ro00000ABCDE');
    assertEq_(normalizeOpportunity_(' 006Ro00000ABCDEIAQ '), '006Ro00000ABCDEIAQ');
    assertEq_(normalizeOpportunity_('https://x.lightning.force.com/lightning/r/Opportunity/006Ro00000ABCDEIAQ/view'), '006Ro00000ABCDEIAQ');
    assertEq_(normalizeOpportunity_('https://x.my.salesforce.com/006Ro00000ABCDE'), '006Ro00000ABCDE');
    assertEq_(normalizeOpportunity_('Linker MSA — Linker Finance — Closed Won (M W) [006Ro00000ABCDEIAQ]'), '006Ro00000ABCDEIAQ');
    assertEq_(normalizeOpportunity_('Linker Finance'), null);
    assertEq_(normalizeOpportunity_('001Ro00001FDEtnIAH'), null, 'an Account Id is not an Opportunity Id');
    assertEq_(normalizeOpportunity_('006Ro00000ABCD'), null, '14 chars');
    assertEq_(normalizeOpportunity_(''), null);
    assertEq_(normalizeOpportunity_(null), null);
  });

  // --- gate: opportunity + required ---
  var schema = {
    type_of_contract: { key: 'type_of_contract', name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist', length: 255, scale: 0, precision: 0, controller: null, required: false,
                        values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] }] },
    exclusivity: { key: 'exclusivity', name: 'Exclusivity__c', label: 'Exclusivity', type: 'boolean', length: 0, scale: 0, precision: 0, controller: null, values: null, required: false },
    contract_start_date: { key: 'contract_start_date', name: 'StartDate', label: 'Contract Start Date', type: 'date', length: 0, scale: 0, precision: 0, controller: null, values: null, required: true }
  };
  var okFields = { 'Opportunity': 'https://x.lightning.force.com/lightning/r/Opportunity/006Ro00000ABCDEIAQ/view',
                   'Account Name': 'Linker Finance', 'Type of contract': 'msa', 'Countries where services': 'France',
                   'Exclusivity': false, 'Start': '2026-01-15' };

  t('requiredLabels_: Config list + schema required flag + the Opportunity row, in sheet order', function () {
    assertEq_(requiredLabels_(cfg, schema, Object.keys(okFields)), ['Opportunity', 'Type of contract', 'Countries where services', 'Start']);
    assertEq_(requiredLabels_({ field_keys: { Start: 'contract_start_date' } }, schema, ['Start', 'Notes']), ['Start'], 'schema flag alone');
  });
  t('validateApproval_: URL in the Opportunity cell becomes a bare Id; false boolean passes required', function () {
    var g = validateApproval_({ fields: okFields }, cfg, schema);
    assert_(g.ok, g.message);
    assertEq_(g.fields.Opportunity, '006Ro00000ABCDEIAQ');
    assertEq_(g.fields.Exclusivity, false);
  });
  t('validateApproval_: blank Opportunity blocks with the paste/pick message', function () {
    var f = Object.assign({}, okFields, { Opportunity: '' });
    var g = validateApproval_({ fields: f }, cfg, schema);
    assert_(!g.ok, 'blocked');
    assertEq_(g.errors.length, 1);
    assert_(g.errors[0].indexOf('Opportunity: paste the Salesforce Opportunity Id') === 0, g.errors[0]);
  });
  t('validateApproval_: an account name in the Opportunity cell is not an Id', function () {
    var g = validateApproval_({ fields: Object.assign({}, okFields, { Opportunity: 'Linker Finance' }) }, cfg, schema);
    assert_(!g.ok && g.errors.length === 1 && g.errors[0].indexOf('Opportunity:') === 0, g.message);
  });
  t('validateApproval_: every blank required cell is reported once, a typing failure is not doubled', function () {
    var f = Object.assign({}, okFields, { 'Type of contract': 'Master Service', 'Countries where services': '', 'Start': '   ' });
    var g = validateApproval_({ fields: f }, cfg, schema);
    assert_(!g.ok, 'blocked');
    assertEq_(g.errors.length, 3, g.message);
    assert_(g.errors[0].indexOf('Type of contract: "Master Service" is not an option') === 0, g.errors[0]);
    assertEq_(g.errors[1], 'Countries where services: required before this can be sent');
    assertEq_(g.errors[2], 'Start: required before this can be sent');
  });

  // --- payload ---
  t('buildPayload_: [info] rows stay out of fields but remain in provenance; owner_email rides from Config', function () {
    var approval = { correlationId: 'c', fileId: 'F', fileName: 'f.pdf', model: 'm', extractedAt: 't',
                     fields: okFields, extracted: { 'Account Name': 'Linker Finance', 'Type of contract': 'MSA' } };
    var g = validateApproval_(approval, cfg, schema);
    var p = buildPayload_(approval, cfg, g.fields);
    assertEq_(p.fields.opportunity, '006Ro00000ABCDEIAQ');
    assertEq_(p.fields.owner_email, 'owner@example.com');
    assertEq_(p.fields.exclusivity, false, 'false is sent as false, not dropped or blanked');
    assert_(!('account_name' in p.fields), 'info row not pushed');
    assert_(!('account_id' in p.fields), 'no account on the wire');
    assertEq_(p.provenance.extracted.account_name, 'Linker Finance');
  });
  t('buildPayload_: blank contract_owner_email -> no owner_email key at all', function () {
    var p = buildPayload_({ correlationId: 'c', fileId: 'F', fields: { X: '1' }, extracted: {} }, { field_keys: {}, contract_owner_email: '' });
    assert_(!('owner_email' in p.fields), 'absent, so the recipe falls back to the opportunity owner');
  });

  // --- search response ---
  t('interpretSearchResponse_: 200 ok -> candidates (id required, label falls back to id)', function () {
    var c = interpretSearchResponse_(200, { ok: true, candidates: [{ id: '006A', label: 'A — Acct — Stage (O)' }, { id: '006B' }, { label: 'no id' }, null] });
    assertEq_(c, [{ id: '006A', label: 'A — Acct — Stage (O)' }, { id: '006B', label: '006B' }]);
    assertEq_(interpretSearchResponse_(200, { ok: true, candidates: [] }), []);
  });
  t('interpretSearchResponse_: non-JSON, non-200 and ok:false throw (the caller turns these into [] + a warning)', function () {
    assertThrows_(function () { interpretSearchResponse_(200, null); }, 'not JSON');
    assertThrows_(function () { interpretSearchResponse_(400, { ok: false, message: 'boom' }); }, 'boom');
    assertThrows_(function () { interpretSearchResponse_(200, { ok: false, message: 'nope' }); }, 'nope');
  });
  t('candidateOption_ round-trips through normalizeOpportunity_', function () {
    var text = candidateOption_({ id: '006Ro00000ABCDEIAQ', label: 'Linker MSA — Linker Finance — Negotiation (M W)' });
    assertEq_(text, 'Linker MSA — Linker Finance — Negotiation (M W) [006Ro00000ABCDEIAQ]');
    assertEq_(normalizeOpportunity_(text), '006Ro00000ABCDEIAQ');
  });

  // --- review-sheet plan ---
  t('planApprovedCells_: Opportunity row is blank, flagged as required, with an advisory dropdown of suggestions', function () {
    var cands = [{ id: '006Ro00000ABCDEIAQ', label: 'Linker MSA — Linker Finance — Negotiation (M W)' }];
    var plan = planApprovedCells_(cfg, schema, cfg.output_fields, { 'Account Name': 'Linker Finance', 'Type of contract': 'MSA' }, cands);
    var opp = plan[0];
    assertEq_(opp.label, 'Opportunity');
    assertEq_([opp.extracted, opp.seed, opp.role, opp.required, opp.flagged], ['', '', 'manual', true, true]);
    assertEq_(opp.rule.kind, 'list'); assertEq_(opp.rule.strict, false);
    assertEq_(opp.rule.options, ['Linker MSA — Linker Finance — Negotiation (M W) [006Ro00000ABCDEIAQ]']);
    assert_(opp.note.indexOf('paste the Opportunity Id') !== -1, opp.note);
  });
  t('planApprovedCells_: no suggestions -> no dropdown, still blank, flagged and noted', function () {
    var plan = planApprovedCells_(cfg, schema, cfg.output_fields, {}, []);
    assertEq_(plan[0].rule, null);
    assertEq_(plan[0].flagged, true);
    var none = planApprovedCells_(cfg, schema, cfg.output_fields, {});
    assertEq_(none[0].rule, null, 'candidates omitted');
  });
  t('planApprovedCells_: [info] row keeps the model text and says it is not sent; required blank rows are flagged', function () {
    var plan = planApprovedCells_(cfg, schema, cfg.output_fields, { 'Account Name': 'Linker Finance', 'Type of contract': '' }, []);
    var info = plan[1];
    assertEq_([info.role, info.extracted, info.seed, info.flagged], ['info', 'Linker Finance', 'Linker Finance', false]);
    assertEq_(info.note, REVIEW_INFO_NOTE);
    var type = plan[2];
    assertEq_([type.required, type.flagged, type.seed], [true, true, '']);
    var excl = plan[4];
    assertEq_([excl.required, excl.flagged, excl.seed], [false, false, false], 'unticked boolean is not blank');
  });

  // --- schema required flag ---
  t('schemaRows_/schemaFromRows_: Required column round-trips; an old 9-column tab reads as not required', function () {
    var rows = schemaRows_([{ name: 'AccountId', label: 'Account ID', type: 'reference', required: true },
                            { name: 'Name', label: 'Contract Name', type: 'string', required: false }]);
    assertEq_(rows.rows[0][9], true);
    assertEq_(rows.rows[1][9], false);
    var s = schemaFromRows_([SCHEMA_HEADERS].concat(rows.rows));
    assertEq_(s.account_id.required, true);
    assertEq_(s.contract_name.required, false);
    var old = schemaFromRows_([SCHEMA_HEADERS.slice(0, 9), ['k', 'K__c', 'K', 'string', 0, 0, 0, '', '']]);
    assertEq_(old.k.required, false);
  });
}

/** "Not found" phrases from the model, and the shape of gate failures on the sheet. All pure. */
function registerBlankPhraseAndErrorTests_(t) {
  var base = { folder_id_ingestion: 'a', folder_id_processed: 'b', folder_id_failed: 'c', folder_id_pending: 'd',
    folder_id_pushed: 'e', folder_id_cancelled: 'f', prompt_template: 'p', project_id: 'g', workato_webhook_url: 'u',
    output_fields: 'Type of contract\nGoverning law\nExclusivity\nStart => Contract Start Date',
    required_fields: 'Type of contract' };
  var cfg = parseConfig_(base);

  t('isAbsentPhrase_: defaults apply when the key is absent; case, spaces and a trailing period are ignored', function () {
    assertEq_(cfg.blank_phrases, DEFAULT_BLANK_PHRASES);
    assert_(isAbsentPhrase_(cfg, 'Not mentioned in the document'));
    assert_(isAbsentPhrase_(cfg, '  not mentioned in the document.  '));
    assert_(isAbsentPhrase_(cfg, 'N/A'));
    assert_(!isAbsentPhrase_(cfg, 'Not mentioned in the document, but implied by clause 4'), 'whole-value match only');
    assert_(!isAbsentPhrase_(cfg, ''));
    assert_(!isAbsentPhrase_(cfg, false));
    assert_(!isAbsentPhrase_(cfg, 'Delaware'));
  });
  t('isAbsentPhrase_: Config blank_phrases replaces the defaults', function () {
    var c = parseConfig_(Object.assign({}, base, { blank_phrases: 'Nothing found, —' }));
    assertEq_(c.blank_phrases, ['Nothing found', '—']);
    assert_(isAbsentPhrase_(c, 'nothing found.'));
    assert_(!isAbsentPhrase_(c, 'Not mentioned in the document'), 'default list no longer applies');
  });

  var schema = {
    type_of_contract: { key: 'type_of_contract', name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist', length: 255, scale: 0, precision: 0, controller: null, required: false,
                        values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] }] },
    governing_law: { key: 'governing_law', name: 'Governing_Law__c', label: 'Governing Law', type: 'string', length: 255, scale: 0, precision: 0, controller: null, values: null, required: false },
    exclusivity: { key: 'exclusivity', name: 'Exclusivity__c', label: 'Exclusivity', type: 'boolean', length: 0, scale: 0, precision: 0, controller: null, values: null, required: false },
    contract_start_date: { key: 'contract_start_date', name: 'StartDate', label: 'Contract Start Date', type: 'date', length: 0, scale: 0, precision: 0, controller: null, values: null, required: false }
  };

  t('planApprovedCells_: a "not found" phrase stays in Extracted and seeds Approved blank (false for a boolean)', function () {
    var plan = planApprovedCells_(cfg, schema, cfg.output_fields, {
      'Type of contract': 'Not mentioned in the document', 'Governing law': 'Delaware',
      'Exclusivity': 'Not mentioned in the document.', 'Start': 'N/A' }, []);
    assertEq_(plan[0].extracted, 'Not mentioned in the document');
    assertEq_(plan[0].seed, '');
    assertEq_(plan[0].flagged, true, 'required and blank');
    assert_(plan[0].note.indexOf('found nothing') !== -1, plan[0].note);
    assertEq_([plan[1].seed, plan[1].flagged], ['Delaware', false]);
    assertEq_([plan[2].seed, plan[2].flagged], [false, false], 'boolean seeds unticked, not flagged');
    assertEq_([plan[3].seed, plan[3].flagged, plan[3].rule.kind], ['', false, 'date']);
  });

  t('validateApproval_: a phrase left in Approved behaves as blank — skipped if optional, reported if required', function () {
    var g = validateApproval_({ fields: { 'Type of contract': 'MSA', 'Governing law': 'Not mentioned in the document', 'Exclusivity': false, 'Start': 'N/A' } }, cfg, schema);
    assert_(g.ok, g.message);
    assertEq_(g.fields['Governing law'], null);
    assertEq_(g.fields.Start, null);
    var r = validateApproval_({ fields: { 'Type of contract': 'Not mentioned in the document', 'Governing law': '', 'Exclusivity': false, 'Start': '' } }, cfg, schema);
    assert_(!r.ok, 'required');
    assertEq_(r.errors, ['Type of contract: required before this can be sent']);
  });

  t('gateMessage_: headline with a count, then one bullet per cell; singular when one', function () {
    var one = gateMessage_(['Start: "x" is not a date; use YYYY-MM-DD']);
    assert_(one.indexOf('Not sent — 1 cell needs attention') === 0, one);
    assertEq_(one.split('\n').length, 2);
    var two = gateMessage_(['A: bad', 'B: worse']);
    assert_(two.indexOf('Not sent — 2 cells need attention') === 0, two);
    assertEq_(two.split('\n').slice(1), ['• A: bad', '• B: worse']);
    assert_(two.indexOf('next poll retries') !== -1, 'tells the reviewer what happens after fixing');
  });

  t('splitGateErrors_ groups by label; stripErrorNote_ removes only the ⚠ paragraph', function () {
    assertEq_(splitGateErrors_(['A: one', 'B: x', 'A: two', 'malformed']), { A: ['one', 'two'], B: ['x'] });
    assertEq_(stripErrorNote_('⚠ bad\n\nPick one from the list.'), 'Pick one from the list.');
    assertEq_(stripErrorNote_('⚠ bad'), '');
    assertEq_(stripErrorNote_('Pick one from the list.'), 'Pick one from the list.');
    assertEq_(stripErrorNote_(''), '');
  });

  t('fieldInstruction_: the prompt forbids placeholders explicitly', function () {
    var p = fieldInstruction_(['X']);
    assert_(p.indexOf('do not write') !== -1 && p.indexOf('Not mentioned') !== -1, p);
  });
}
