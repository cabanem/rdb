/**
 * @file 000_FormChannel.gs
 * Normalizes the form-channel (manual-entry form) viability block returned by the Workato endpoints, and folds it
 * into the verdict as a synthetic check so every existing checks[] consumer (the validation modal and _validation_results) renders
 * it without modification. Sibling to ValidationReport; owns no UI and no I/O.
 *
 * Wire contract (CAN-01 build_form_channel; keep the two in sync):
 *   status: 'viable' | 'degraded' | 'unavailable'
 *     viable      - every visible field holds a form slot.
 *     degraded    - required fields all fit, but one+ OPTIONAL fields were dropped (slot pool exhausted, or cascade parent unmappable).
 *                   The upload path is unaffected.
 *     unavailable - a required field (or its gating cascade chain) cannot be represented on the form: per-family capacity deficit or a
 *                   dependency defect. The upload path is unaffected.
 *   detail_json (JSON string):
 *     { status, capacities_used, per_type: {family: {capacity, required,
 *       closure_added, optional, allocated, deficit}}, required_unplaced[],
 *       dropped_optional[], defects[] }
 *
 * Accepted wire shapes (first candidate that carries a status wins):
 *   API-00 provision: parsed.form_channel         = { status, detail_json }
 *   API-02 validate:  parsed.verdict.form_channel = { status, detail_json }   (unified)
 *   API-02 legacy:    parsed.verdict.form_channel = { form_channel_status, form_detail_json }
 * 
 * The legacy names are accepted so the library keeps working against a recipe that has not yet been updated.
 *
 * Public:
 *   FormChannel.extract(parsed)               -> { status, detail } | null
 *   FormChannel.toCheck(fc)                   -> synthetic check | null
 *   FormChannel.mergeIntoVerdict(verdict, fc) -> new verdict object (never mutates)
 *   FormChannel.describe(fc)                  -> one-line human summary
 */
var FormChannel = {};

FormChannel.CHECK_NAME = 'form_channel_viability';

FormChannel.SEVERITY_BY_STATUS = Object.freeze({
  viable:      'pass',
  degraded:    'warn',
  unavailable: 'fail'
});

/**
 * Locate and normalize the form-channel block anywhere it is known to appear. Returns { status, detail } where detail
 * is the parsed detail object, or null when detail_json is absent/unparseable (status still surfaces alone). Returns
 * null overall when no candidate carries a status - callers treat that as "this response has no form-channel information", 
 * which is legitimate (e.g. API-02 when CFG-01 found the config invalid, so CAN-01 never ran).
 */
FormChannel.extract = function(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  var v = parsed.verdict  || {};   // API-02 validate envelope
  var r = parsed.response || {};   // defensive: one wrapper deeper
  var candidates = [
    parsed.form_channel,           // API-00 provision envelope (top level)
    v.form_channel,                // API-02 verdict
    r.form_channel,                // response-wrapped variant
    r.verdict && r.verdict.form_channel
  ];

  for (var i = 0; i < candidates.length; i++) {
    var fc = candidates[i];
    if (!fc || typeof fc !== 'object') continue;

    var status = String(fc.status || fc.form_channel_status || '').trim().toLowerCase();
    if (!status) continue;

    var raw = (fc.detail_json !== undefined && fc.detail_json !== null && fc.detail_json !== '')
            ? fc.detail_json
            : fc.form_detail_json;

    var detail = null;
    if (raw && typeof raw === 'object') {
      detail = raw;                                  // already-parsed object
    } else if (typeof raw === 'string' && raw.replace(/\s/g, '') !== '') {
      try { detail = JSON.parse(raw); } catch (e) {} // keep null; status alone still surfaces
    }
    return { status: status, detail: detail };
  }
  return null;
};

/**
 * Convert a normalized form-channel block into a check in the verdict shape ({check_name, c_status, message, details[]}), 
 * so it flows through ValidationReport.toModel, _toRows, and the modal exactly like a CFG-01 check.
 *
 * Severity mapping: viable -> pass, degraded -> warn, unavailable -> fail.
 * An unrecognized status maps to warn.
 *
 * Detail rows are emitted worst-first: unplaced REQUIRED fields, then dependency defects, then dropped optional 
 * fields. entity is 'field' throughout; `name` is the field name and `issue` explains why it cannot (or does not) hold a slot.
 */
FormChannel.toCheck = function(fc) {
  if (!fc || !fc.status) return null;

  var severity = FormChannel.SEVERITY_BY_STATUS[fc.status] || 'warn';
  var d = (fc.detail && typeof fc.detail === 'object') ? fc.detail : {};
  var details = [];

  (Array.isArray(d.required_unplaced) ? d.required_unplaced : []).forEach(function(f) {
    details.push({
      entity: 'field',
      name:   String(f.field_name || ''),
      issue:  'REQUIRED field holds no form slot: ' +
              String(f.reason || 'slot pool exhausted')
    });
  });

  (Array.isArray(d.defects) ? d.defects : []).forEach(function(f) {
    var issue;
    switch (String(f.type || '')) {
      case 'dependency_parent_not_visible':
        issue = 'cascade parent "' + String(f.parent_field_name || '') +
                '" is not visible on the form, so this required dependent cannot render';
        break;
      case 'dependency_parent_unmappable':
        issue = 'cascade parent "' + String(f.parent_field_name || '') +
                '" holds no form slot, so this required dependent cannot render';
        break;
      default:
        issue = String(f.type || 'dependency defect');
    }
    details.push({ entity: 'field', name: String(f.field_name || ''), issue: issue });
  });

  (Array.isArray(d.dropped_optional) ? d.dropped_optional : []).forEach(function(f) {
    details.push({
      entity: 'field',
      name:   String(f.field_name || ''),
      issue:  'optional field dropped from the form: ' + String(f.reason || '')
    });
  });

  return {
    check_name: FormChannel.CHECK_NAME,
    c_status:   severity,
    message:    FormChannel.describe(fc),
    details:    details
  };
};

/**
 * One-line human summary: status meaning first, per-family slot usage after (e.g. "... Slot 
 * usage: text 10/10, num 2/4, bool 0/2, sel 3/10, date 1/4.").
 * Reads entirely from the detail block; degrades to status-only when the detail was absent or unparseable.
 */
FormChannel.describe = function(fc) {
  var d = (fc.detail && typeof fc.detail === 'object') ? fc.detail : {};

  var usage = '';
  if (d.per_type && typeof d.per_type === 'object') {
    usage = Object.keys(d.per_type).map(function(family) {
      var t = d.per_type[family] || {};
      var used = (t.allocated === 0 || t.allocated) ? t.allocated : '?';
      var cap  = (t.capacity  === 0 || t.capacity)  ? t.capacity  : '?';
      return family + ' ' + used + '/' + cap;
    }).join(', ');
  }

  var droppedCount  = Array.isArray(d.dropped_optional)  ? d.dropped_optional.length  : 0;
  var unplacedCount = Array.isArray(d.required_unplaced) ? d.required_unplaced.length : 0;
  var defectCount   = Array.isArray(d.defects)           ? d.defects.length           : 0;

  var head;
  switch (fc.status) {
    case 'viable':
      head = 'Manual-entry form is viable: every visible field holds a slot.';
      break;
    case 'degraded':
      head = 'Manual-entry form is degraded: all required fields fit, but ' +
             droppedCount + ' optional field(s) were dropped. ' +
             'The upload path is unaffected.';
      break;
    case 'unavailable':
      head = 'Manual-entry form is unavailable: ' +
             (unplacedCount ? unplacedCount + ' required field(s) hold no slot' : '') +
             (unplacedCount && defectCount ? '; ' : '') +
             (defectCount ? defectCount + ' dependency defect(s)' : '') +
             (!unplacedCount && !defectCount ? 'a required field (or its cascade chain) cannot be represented' : '') +
             '. The upload path is unaffected.';
      break;
    default:
      head = 'Manual-entry form status "' + fc.status +
             '" is not recognized by this library version.';
  }
  return usage ? head + ' Slot usage: ' + usage + '.' : head;
};

/**
 * Return a NEW verdict with the synthetic form-channel check appended to checks[]. Never mutates either 
 * input - Validate/Provision hand the same verdict object to both the sheet writer and the modal, so in-place 
 * mutation here would be a spooky-action style bug.
 *
 * Behavior:
 *   - no form-channel block          -> verdict returned unchanged.
 *   - verdict null, block present    -> minimal verdict synthesized ({status:'',
 *     checks:[check]}), so the finding still reaches the modal & sheet even when the EP returned no checks[] (envelope drift, partial failure).
 *   - idempotent: an existing form_channel_viability check is replaced, so calling resolve() twice cannot double-report.
 */
FormChannel.mergeIntoVerdict = function(verdict, fc) {
  var check = FormChannel.toCheck(fc);
  if (!check) return verdict;

  var base = (verdict && typeof verdict === 'object') ? verdict : { status: '' };

  var checks = (Array.isArray(base.checks) ? base.checks : []).filter(function(c) {
    return String((c && c.check_name) || '').trim() !== FormChannel.CHECK_NAME;
  });
  checks.push(check);

  var merged = {};
  Object.keys(base).forEach(function(key) { merged[key] = base[key]; });
  merged.checks = checks;
  return merged;
};