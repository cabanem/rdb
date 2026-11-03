/**
 * @file guide.js (container-bound shim)
 *
 * "Data collection guide" sidebar: the onOpen menu laid out in the order the
 * work actually happens, with each step's state read from the workbook.
 *
 * How it fits together
 *   - GUIDE_STEPS below is the single source of truth for the order of
 *     operations. Each entry is a function of the workbook facts and returns
 *     a step (or null to hide it). The sidebar renders whatever guideStatus()
 *     hands it; it knows nothing about steps.
 *   - Facts come from two places:
 *       (a) structural checks: cheap sheet reads and library version calls;
 *       (b) marks: when a flow shim finishes, it calls guideMark_(key, r),
 *           which stores {at, ok, by} in Document Properties. Marks are
 *           per-workbook and shared by everyone who opens it.
 *   - Actions ARE the existing menu functions, called by name from the
 *     sidebar via google.script.run. Nothing is duplicated; the alerts and
 *     modals those functions show still appear over the sheet.
 *
 * Known gaps
 *   - A workbook provisioned before this file existed has no marks, so the
 *     push steps show as not yet done until the next run. If lib_sdc keeps a
 *     provisioned flag anywhere (e.g. _developer_settings), teach
 *     isProvisioned_() to read it.
 *   - 1_customer completeness is not detected here; Validate is the source
 *     of truth for that, so the step is shown as a manual one.
 */

var GUIDE_PROP_PREFIX   = 'sdc.guide.';        // Document Properties: sdc.guide.<key> = JSON mark
var GUIDE_AUTOOPEN_PROP = 'sdc.guide.autoOpen'; // User Properties: 'false' to opt out


// --- Entry points called from the menu / sidebar --------------------------

function guideOpen() {
  var html = HtmlService.createHtmlOutputFromFile('guide_sidebar')
    .setTitle('Data collection guide');
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Sidebar on load / refresh. Plain object so it crosses google.script.run cleanly. */
function guideStatus() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var facts = guideFacts_(ss);

  var steps = GUIDE_STEPS
    .map(function (def) { return def(facts); })
    .filter(function (s) { return !!s; });

  // A blocking step (schema migration) greys out everything after it.
  var blocked = false;
  steps.forEach(function (s, i) {
    if (blocked) { s.state = 'blocked'; s.actions.forEach(function (a) { a.enabled = false; }); }
    if (s.blocksRest) blocked = true;
    s.n = i + 1;
  });

  var next = null;
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].state === 'todo') { next = steps[i].title; break; }
  }

  return {
    steps: steps,
    next: next,
    library: facts.library,
    schema: facts.schemaCurrent + ' / ' + facts.schemaTarget,
    autoOpen: guideAutoOpen_()
  };
}

/** "Open tab" links in the sidebar. */
function guideActivate(sheetName) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) throw new Error('No tab named "' + sheetName + '".');
  sh.activate();
  return sheetName;
}

/** Footer checkbox. Per user, not per workbook. */
function guideSetAutoOpen(on) {
  PropertiesService.getUserProperties().setProperty(GUIDE_AUTOOPEN_PROP, on ? 'true' : 'false');
  return !!on;
}

function guideAutoOpen_() {
  return PropertiesService.getUserProperties().getProperty(GUIDE_AUTOOPEN_PROP) !== 'false';
}


// --- Marks ------------------------------------------------------------------
/**
 * Record that a flow ran. Called by the flow shims right after the library returns.
 *
 * @param {string} key  one of: provision:initial, provision:update, validate,
 *                      preview, invitations, portalInvite, primaryKeySetup
 * @param {Object} r    the library Result (only ok is read)
 */
function guideMark_(key, r) {
  if (!key || !r) return;
  var mark = { at: new Date().toISOString(), ok: !!r.ok, by: '' };
  try { mark.by = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  try {
    PropertiesService.getDocumentProperties().setProperty(GUIDE_PROP_PREFIX + key, JSON.stringify(mark));
  } catch (e) { /* marks are a convenience; never let them break a flow */ }
}

function guideMarks_() {
  var all = PropertiesService.getDocumentProperties().getProperties();
  var out = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(GUIDE_PROP_PREFIX) !== 0 || k === GUIDE_AUTOOPEN_PROP) return;
    try { out[k.substring(GUIDE_PROP_PREFIX.length)] = JSON.parse(all[k]); } catch (e) {}
  });
  return out;
}

function okMark_(m) { return !!(m && m.ok); }

/** "3 Nov 14:05 by ecabaniss" — short enough for a 300px sidebar. */
function when_(m) {
  if (!m || !m.at) return '';
  var s = Utilities.formatDate(new Date(m.at), Session.getScriptTimeZone(), 'd MMM HH:mm');
  if (m.by) s += ' by ' + String(m.by).split('@')[0];
  return s;
}


// --- Facts ------------------------------------------------------------------

function guideFacts_(ss) {
  var H = SDC_MIG.HEADERS;
  var marks = guideMarks_();
  var f = {
    library:         safe_(function () { return SDC.Version.LIBRARY; }, '?'),
    schemaTarget:    safe_(function () { return SDC.Version.SCHEMA; }, '?'),
    schemaCurrent:   safe_(function () { return SDC.Migrations.currentWorkbookVersion(ss); }, '?'),
    migrationNeeded: safe_(function () { return SDC.Migrations.isMigrationNeeded(ss); }, false),
    fieldRows:       dataRows_(ss, SDC_MIG.FIELDS_SHEET,  [H.fieldLookup, H.fieldDependsOn]),
    lookupRows:      dataRows_(ss, SDC_MIG.LOOKUPS_SHEET, [H.table, H.value, H.parent]),
    cascades:        safe_(function () {
                       var t = getTrack2Status({ ss: ss });
                       return { declared: t.rows.length, ready: t.ready };
                     }, { declared: 0, ready: true }),
    marks: marks
  };
  f.provisioned = isProvisioned_(f);
  return f;
}

/** Swap in a library-side signal here if one exists; the marks are the fallback. */
function isProvisioned_(f) {
  return okMark_(f.marks['provision:initial']) || okMark_(f.marks['provision:update']);
}

/**
 * Non-empty rows below the header row, located by name the same way the
 * migration / cascade files do. null = tab missing, 0 = header found but empty.
 */
function dataRows_(ss, name, requiredHeaders) {
  var sh = ss.getSheetByName(name);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  var hr = findHeaderRow_(values, requiredHeaders);
  if (hr === -1) return 0;
  var n = 0;
  for (var r = hr + 1; r < values.length; r++) {
    if (values[r].some(function (c) { return trim_(c) !== ''; })) n++;
  }
  return n;
}

function safe_(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}


// --- The order of operations ----------------------------------------------
/**
 * Step states, as the sidebar draws them:
 *   todo      - the next thing to do (filled marker, primary button)
 *   done      - detected or marked complete (check)
 *   optional  - available, not required (hollow marker)
 *   manual    - a thing to do in the sheet, not something to run (hollow marker)
 *   blocked   - not yet runnable (greyed; set here or by a blocksRest step)
 */

function step_(id, phase, title, hint, state, actions, tabs, extra) {
  var s = { id: id, phase: phase, title: title, hint: hint, state: state,
            actions: actions || [], tabs: tabs || [] };
  if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
  return s;
}
/** fn must be a global in this container; the sidebar calls google.script.run[fn](). */
function act_(label, fn, primary, enabled) {
  return { label: label, fn: fn, primary: !!primary, enabled: enabled !== false };
}

var GUIDE_STEPS = [

  // -- Prepare ---------------------------------------------------------------
  function (f) {
    if (!f.migrationNeeded) return null;
    return step_('migrate', 'Prepare', 'Migrate workbook schema',
      'Schema v' + f.schemaCurrent + ' \u2192 v' + f.schemaTarget + '. Nothing else runs reliably until this is done.',
      'todo', [act_('Migrate\u2026', 'migrateWorkbookSchema', true)], [], { blocksRest: true });
  },

  function (f) {
    return step_('customer', 'Prepare', 'Describe the client',
      'Fill in 1_customer. Validate (below) checks it; nothing to run here.',
      'manual', [], ['1_customer']);
  },

  // -- Define fields ---------------------------------------------------------
  function (f) {
    var loaded = f.fieldRows > 0;
    return step_('fields', 'Define fields', 'Load the fields',
      loaded
        ? f.fieldRows + ' field row(s), ' + (f.lookupRows || 0) + ' lookup row(s).'
        : (f.fieldRows === null ? 'The 4_fields tab is missing.' : 'Apply a field pack, or author 4_fields and 5_lookups by hand.'),
      loaded ? 'done' : 'todo',
      [act_('Set up from field pack\u2026', 'setupFromPack', !loaded)],
      [SDC_MIG.FIELDS_SHEET, SDC_MIG.LOOKUPS_SHEET]);
  },

  function (f) {
    var m = f.marks['primaryKeySetup'], done = okMark_(m);
    return step_('fieldIds', 'Define fields', 'Set up field IDs',
      done ? 'Last run ' + when_(m) + '. Safe to re-run after adding fields.'
           : 'Stamps the ID column every field row needs. Safe to re-run.',
      done ? 'done' : (f.fieldRows > 0 ? 'todo' : 'blocked'),
      [act_('Set up field IDs', 'setupPrimaryKeyColumns', !done, f.fieldRows > 0)], []);
  },

  function (f) {
    if (!f.cascades.declared) return null;          // flat lists only: nothing to complete
    var ready = f.cascades.ready;
    return step_('cascades', 'Define fields', 'Complete the cascades',
      f.cascades.declared + ' dependent list(s) declared in 4_fields. ' +
        (ready ? 'Every child row has a parent value.' : 'Some rows still need a parent value.'),
      ready ? 'done' : 'todo',
      [act_('Stamp dropdowns', 'stampCascadeDropdowns', !ready),
       act_('Completeness\u2026', 'showTrack2Sidebar', false)],
      [SDC_MIG.LOOKUPS_SHEET]);
  },

  // -- Check -----------------------------------------------------------------
  function (f) {
    var m = f.marks['validate'], done = okMark_(m);
    return step_('validate', 'Check', 'Validate configuration',
      done ? 'Passed ' + when_(m) + '. Re-validate after any edit.'
           : (m ? 'Last run failed ' + when_(m) + '. Fix the errors and run again.'
                : 'Runs the preflight checks. Fix every error before pushing.'),
      done ? 'done' : 'todo',
      [act_('Validate', 'validateConfiguration', true)], []);
  },

  function (f) {
    var m = f.marks['preview'], done = okMark_(m);
    return step_('preview', 'Check', 'Preview the supplier template',
      done ? 'Built ' + when_(m) + '.' : 'Optional. Downloads the .xlsx a supplier would receive.',
      done ? 'done' : 'optional',
      [act_('Preview\u2026', 'previewTemplate', false)], []);
  },

  // -- Push to Workato -------------------------------------------------------
  function (f) {
    var m = f.marks['provision:initial'];
    return step_('start', 'Push to Workato', 'Start supplier data collection',
      f.provisioned ? 'First push ' + when_(m) + '. Use Update for later changes.'
                    : 'Sends the configuration to Workato for the first time.',
      f.provisioned ? 'done' : 'todo',
      f.provisioned ? [] : [act_('Start', 'initializeWorkspace', true)], []);
  },

  function (f) {
    var m = f.marks['provision:update'];
    return step_('update', 'Push to Workato', 'Update configuration',
      okMark_(m) ? 'Last update ' + when_(m) + '.'
                 : 'Re-sends the configuration after you change it.',
      f.provisioned ? 'optional' : 'blocked',
      [act_('Update', 'updateWorkspace', f.provisioned, f.provisioned)], []);
  },

  function (f) {
    var m = f.marks['invitations'], done = okMark_(m);
    return step_('invitations', 'Push to Workato', 'Send supplier invitations',
      done ? 'Last batch ' + when_(m) + '.' : 'Invites every pending supplier. Needs a started collection.',
      done ? 'done' : (f.provisioned ? 'todo' : 'blocked'),
      [act_('Send invitations', 'sendAllInvitations', f.provisioned, f.provisioned)], []);
  },

  function (f) {
    var m = f.marks['portalInvite'], done = okMark_(m);
    return step_('portal', 'Push to Workato', 'Request portal access',
      done ? 'Requested ' + when_(m) + '.' : 'Gets you (the analyst) into the supplier portal for this application.',
      done ? 'done' : 'optional',
      [act_('Request access', 'requestPortalAccess', false)], []);
  }
];
