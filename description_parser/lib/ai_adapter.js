/**
 * AiAdapter.gs — optional. Asks Gemini (Vertex AI) to read descriptions the regex extractors
 * could not handle, then validates every answer against the sheet's own vocabulary.
 *
 * The model proposes. The code decides what is allowed. Nothing the model says reaches the
 * review tab unless it passes dpValidateFieldValue / the rule and field-name checks.
 *
 * Turn it on with Script Properties:
 *   DP_AI_MODE      = gaps   (only descriptions with a rule-like signal and no regex hit)   or   all
 *   DP_GCP_PROJECT  = your-gcp-project-id
 *   DP_GCP_LOCATION = global            (or a region such as europe-west1)
 *   DP_GEMINI_MODEL = gemini-2.5-flash  (any Gemini model available in that location)
 *
 * appsscript.json needs the cloud-platform scope (see README). The account running the script
 * needs the Vertex AI User role on that project.
 *
 * To use your GeminiLib instead: replace the body of dpAiComplete_ so it returns parsed JSON.
 */

var DP_AI_SYSTEM = [
  'You read field descriptions from a data-collection configuration sheet and extract validation rules.',
  'Return ONLY what the description states or clearly implies. Never invent values, bounds, or conditions.',
  'If a description carries no rule, return empty arrays for that item.',
  '',
  'Columns you may fill (use the exact column name):',
  '  "Data type"                — one of: {{dataTypes}}',
  '  "Data format"              — one of: {{dataFormats}}',
  '  "Required", "Unique", "Hidden", "Read-only", "Strict?" — true or false',
  '  "Field length validation"  — character-count bound in interval notation',
  '  "Numeric field validation" — numeric bound in interval notation',
  '  "Date field validation"    — date bound: < TODAY, <= TODAY, > TODAY, >= TODAY, or an operator + YYYY-MM-DD',
  '  "Field input validation"   — a regular expression',
  '  "Data cleaning flags"      — comma-separated from: {{flags}}',
  '',
  'Interval notation: "exact: 9", "[5, 10]" (inclusive), "(0, 100)" (exclusive), "[0, 100)", "> 0", ">= 0", "< 50", "<= 50".',
  '',
  'allowed_values: fill when the description lists the only permitted entries (not examples). Do not set Data format = dropdown yourself; allowed_values handles it.',
  '',
  'complex_rules: fill when a rule depends on ANOTHER field. rule is one of: {{rules}}.',
  'condition_field must be one of the known field names given. condition_value is the literal value that triggers the rule.',
  'Skip rules with compound conditions (and / or) or presence tests ("is not blank") — the form cannot express them.',
  '',
  'evidence: quote the words from the description that support each item.'
].join('\n');

var DP_AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          field_updates: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { column: { type: 'STRING' }, value: { type: 'STRING' }, evidence: { type: 'STRING' } },
              required: ['column', 'value', 'evidence']
            }
          },
          allowed_values: { type: 'ARRAY', items: { type: 'STRING' } },
          complex_rules: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { rule: { type: 'STRING' }, condition_field: { type: 'STRING' }, condition_value: { type: 'STRING' }, evidence: { type: 'STRING' } },
              required: ['rule', 'condition_field', 'evidence']
            }
          }
        },
        required: ['id', 'field_updates', 'allowed_values', 'complex_rules']
      }
    }
  },
  required: ['items']
};

/**
 * entries: [{ r, ctx, desc, proposals }] from dpScan. Appends AI proposals onto entry.proposals in place.
 */
function dpAiPropose(entries, settings) {
  if (!entries.length) return;
  var vocab = entries[0].ctx.vocab;
  var system = DP_AI_SYSTEM
    .replace('{{dataTypes}}', vocab.dataTypes.join(', '))
    .replace('{{dataFormats}}', vocab.dataFormats.join(', '))
    .replace('{{flags}}', vocab.flags.join(', '))
    .replace('{{rules}}', vocab.rules.join(' | '));

  var lookups = entries[0].ctx.lookupTables;
  var lookupSummary = Object.keys(lookups).map(function (n) {
    var vals = dpUnique_(lookups[n].values.filter(Boolean));
    return vals.length <= 15 ? n + ': ' + vals.join(', ') : n + ' (' + vals.length + ' values)';
  }).join('\n');

  for (var start = 0; start < entries.length; start += settings.AI_BATCH_SIZE) {
    var batch = entries.slice(start, start + settings.AI_BATCH_SIZE);
    var user = [
      'Known field names (for condition_field):', entries[0].ctx.fieldNames.join(' | '), '',
      'Existing lookup tables:', lookupSummary, '',
      'Items:',
      JSON.stringify(batch.map(function (e, i) {
        return { id: String(start + i), field_name: e.ctx.fieldName, data_type: e.ctx.dataType, data_format: e.ctx.dataFormat, description: e.desc };
      }), null, 1)
    ].join('\n');

    var parsed = dpAiComplete_(system, user, DP_AI_SCHEMA, settings);
    (parsed.items || []).forEach(function (item) {
      var e = entries[Number(item.id)];
      if (!e) return;
      dpAiToProposals_(item, e.ctx).forEach(function (p) { e.proposals.push(p); });
    });
  }
}

/** Convert one AI item into validated proposals. Anything that fails validation becomes a low-confidence row with a REJECTED note. */
function dpAiToProposals_(item, ctx) {
  var out = [];
  (item.field_updates || []).forEach(function (u) {
    var p = dpP_('fields', u.column, u.value, 'ai', 'ai', u.evidence);
    var known = Object.keys(DP_COL).some(function (k) { return DP_COL[k] === u.column; });
    if (!known) { p.column = DP_COL.DESC; p.note = 'REJECTED: unknown column "' + u.column + '"'; p.confidence = 'low'; }
    else { var err = dpValidateFieldValue(p, ctx.vocab); if (err) { p.note = 'REJECTED: ' + err; p.confidence = 'low'; } }
    if (p.column === DP_COL.FORMAT && p.value === 'dropdown' && (item.allowed_values || []).length) return; // handled below
    out.push(p);
  });

  var vals = dpUnique_((item.allowed_values || []).map(function (v) { return String(v).trim(); }).filter(Boolean));
  if (vals.length >= 2) dpLookupProposals(vals, ctx, 'ai', 'ai', 'allowed_values: ' + vals.join(', ')).forEach(function (p) { out.push(p); });

  (item.complex_rules || []).forEach(function (c) {
    var rule = ctx.vocab.rules.filter(function (r) { return dpNorm_(r) === dpNorm_(c.rule); })[0];
    var res = dpResolveField_(String(c.condition_field || ''), ctx);
    var note = '', conf = 'ai';
    if (!rule) { note = 'REJECTED: unknown rule "' + c.rule + '"'; conf = 'low'; rule = String(c.rule); }
    if (res.match === 'none') { note = dpJoinNote_(note, 'condition field "' + c.condition_field + '" not found in 4_fields'); conf = 'low'; }
    out.push(dpP_('rules', rule, { conditionField: res.name, conditionValue: String(c.condition_value || '').trim() }, conf, 'ai', c.evidence, note));
  });
  return out;
}

/**
 * One call to Gemini on Vertex AI. Returns the parsed JSON object.
 * Swap this body for a GeminiLib call if you prefer — keep the signature and return parsed JSON.
 */
function dpAiComplete_(systemText, userText, responseSchema, settings) {
  var s = settings || dpSettings_();
  if (!s.GCP_PROJECT) throw new Error('Script Property DP_GCP_PROJECT is not set');
  var host = s.GCP_LOCATION === 'global' ? 'aiplatform.googleapis.com' : s.GCP_LOCATION + '-aiplatform.googleapis.com';
  var url = 'https://' + host + '/v1/projects/' + s.GCP_PROJECT + '/locations/' + s.GCP_LOCATION +
            '/publishers/google/models/' + s.GEMINI_MODEL + ':generateContent';
  var body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: responseSchema }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('Vertex AI HTTP ' + code + ': ' + text.slice(0, 300));
  var json = JSON.parse(text);
  var parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  var out = parts.map(function (p) { return p.text || ''; }).join('').replace(/^```json|```$/g, '').trim();
  try { return JSON.parse(out); }
  catch (e) { throw new Error('Gemini returned non-JSON: ' + out.slice(0, 200)); }
}
