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
 *   - Two kinds of action. Workbook-local ones (migrate, field pack,
 *     cascades, portal access) ARE the existing menu functions, called by name
 *     from the sidebar via google.script.run; their alerts and modals show over
 *     the sheet. Router-bound ones (validate, preview, start, update,
 *     invitations) carry an `action` key from SDC.Actions and run inside the
 *     library's "action in progress" window: the sidebar calls
 *     guideOpenProgress(action), the window calls guideRun(action) and renders
 *     what comes back, and the sidebar polls guideMarkAt(action) to learn when
 *     to re-read the workbook. Their marks record SDC.Actions.succeeded (the
 *     verdict, or the built file), not just Result.ok, so "Passed" and "Built"
 *     mean what they say.
 *
 * Known gaps
 *   - A workbook provisioned before this file existed has no marks, so the
 *     push steps show as not yet done until the next run. If lib_sdc keeps a
 *     provisioned flag anywhere (e.g. _developer_settings), teach
 *     isProvisioned_() to read it.
 *   - "Describe the client" ticks on presence only (SDC.Customer.missingRequired). Whether a date, a cadence or an
 *     email is well formed is still Preflight's call at Start.
 *   - "Send supplier invitations" is hidden until a supplier on 2_suppliers has a user on 3_users. That is the
 *     workbook's roster; Workato's is only the same after the last Start / Update.
 */

var GUIDE_PROP_PREFIX   = 'sdc.guide.';        // Document Properties: sdc.guide.<key> = JSON mark
var GUIDE_AUTOOPEN_PROP = 'sdc.guide.autoOpen'; // User Properties: 'false' to opt out


// --- Entry points called from the menu / sidebar --------------------------

function guideOpen() {
  // A template, not a plain file: the sidebar inlines the library's logo upload control (<?!= SDC.Logo.controlHtml() ?>).
  var html = HtmlService.createTemplateFromFile('guide_sidebar').evaluate()
    .setTitle('Data collection guide');
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Sidebar on load / refresh. Plain object so it crosses google.script.run cleanly. */
function guideStatus() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var facts = guideFacts_(ss);

  var all = GUIDE_STEPS
    .map(function (def) { return def(facts); })
    .filter(function (s) { return !!s; });
  // Two lists: the numbered checklist, and the any-time actions (kind 'action': Update, portal access).
  var steps   = all.filter(function (s) { return s.kind !== 'action'; });
  var actions = all.filter(function (s) { return s.kind === 'action'; });

  // A blocking step (schema migration) greys out everything after it.
  var blocked = false;
  steps.forEach(function (s, i) {
    if (blocked) { s.state = 'blocked'; s.actions.forEach(function (a) { a.enabled = false; }); }
    if (s.blocksRest) blocked = true;
    s.n = i + 1;
  });
  if (blocked) actions.forEach(function (s) { s.state = 'blocked'; s.actions.forEach(function (a) { a.enabled = false; }); });

  var next = null;
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].state === 'todo') { next = steps[i].title; break; }
  }

  // When each router-bound action last left a mark, keyed by action. The sidebar keeps this as the baseline it
  // polls against (guideMarkAt) after opening the progress window, so the window opens without a prior round trip.
  var marks = {};
  all.forEach(function (s) {
    s.actions.forEach(function (a) {
      if (!a.action) return;
      var m = facts.marks[SDC.Actions.get(a.action).markKey];
      marks[a.action] = (m && m.at) || '';
    });
  });

  return {
    steps: steps,
    actions: actions,
    next: next,
    marks: marks,
    workspace: facts.linked ? facts.workspaceKey : '',
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


// --- Router-bound actions: the "action in progress" window -----------------
/**
 * Sidebar button. Opens the library's progress window for one SDC.Actions key. The window runs the action itself
 * (guideRun), so this returns as soon as the dialog is up.
 */
function guideOpenProgress(action) {
  SDC.Actions.openProgress(action);
  return action;
}

/**
 * Called by the progress window. Runs one action, records its mark, and hands back what the window renders.
 * Shows no UI of its own: a ui.alert or showModalDialog here would replace the window mid-run.
 *
 * @returns {{result: Object, detailsHtml: string, download: ?{name: string}}}
 */
function guideRun(action) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var def = SDC.Actions.get(action);
  var r   = SDC.Actions.run(ss, action);
  guideMark_(def.markKey, r, SDC.Actions.succeeded(action, r));
  return guideOutcome_(r);
}

/** Sidebar polling: when the mark behind an action last changed ('' when it never ran). */
function guideMarkAt(action) {
  var m = guideMarks_()[SDC.Actions.get(action).markKey];
  return (m && m.at) || '';
}

/**
 * The window's view of a Result. Result.data stays on the server (a preview carries the whole XLSX as base64);
 * the window gets the user-facing fields plus details rendered by the same builders the menu modals use.
 */
function guideOutcome_(r) {
  var out = {
    result: {
      ok:            !!r.ok,
      flow:          r.flow,
      title:         flowTitle_(r.flow),
      message:       String(r.message || ''),
      warnings:      Array.isArray(r.warnings) ? r.warnings : [],
      error:         r.error || null,
      correlationId: showsCorrelationId_(r.flow) && r.correlationId ? r.correlationId : ''
    },
    detailsHtml: '',
    download:    null
  };
  if (!r.ok || !r.data) return out;

  var d = r.data, parts = [];
  if (r.flow === 'preview' && d.fileContent) {
    cachePreviewBytes_(d);
    out.download = { name: d.fileName || 'preview.xlsx' };
    parts.push(previewMetaHtml_(d.metadata));
  }
  if ((r.flow === 'validate' || r.flow === 'preview') && d.validationResult) {
    var checks = Array.isArray(d.validationResult.checks) ? d.validationResult.checks : [];
    parts.push(validationChecksHtml_(checks));
  }
  if (r.flow === 'invitations' && Array.isArray(d.results) && d.results.length) {
    parts.push(invitationResultsHtml_(d.results));
  }
  var lines = resultDetails_(r);
  if (lines.length) {
    parts.push('<ul class="lines">' + lines.map(function (l) { return '<li>' + esc_(l) + '</li>'; }).join('') + '</ul>');
  }
  out.detailsHtml = parts.join('\n');
  return out;
}


// --- Marks ------------------------------------------------------------------
/**
 * Record that a flow ran. Called by the flow shims right after the library returns.
 *
 * @param {string}  key         one of: link, provision:initial, provision:update, validate,
 *                              preview, invitations, portalInvite, primaryKeySetup
 * @param {Object}  r           the library Result (only ok is read)
 * @param {boolean} [succeeded] outcome-aware success (SDC.Actions.succeeded): a validate with an invalid
 *                              verdict, or a preview with no file, is ok:true but not a success. Defaults to r.ok.
 */
function guideMark_(key, r, succeeded) {
  if (!key || !r) return;
  var ok = succeeded === undefined ? !!r.ok : !!succeeded;
  var mark = { at: new Date().toISOString(), ok: ok, by: '' };
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
  // Binding and client name come from the library's own view of the workbook (Config.build / Customer), so a
  // workbook linked by the implementations app and one linked from the sidebar read the same.
  var config = safe_(function () { return SDC.Config.build(ss); }, null);
  f.workspaceKey = config ? String(config.router.workspaceKey || '').trim() : '';
  f.linked       = !!(f.workspaceKey && config.router.baseUrl);
  f.clientName   = config ? safe_(function () { return String(SDC.Customer.readOne(ss, config, 'clientName') || '').trim(); }, '') : '';
  f.canLink      = typeof SDC.Registry.link === 'function';
  // The logo cell as the library reads it: 'drive' (uploaded or pasted Drive link), 'legacy' (public URL from before
  // schema 1.13), 'blank' or 'invalid'. Null when the library predates Logo or the workbook cannot be read.
  f.logo = config ? safe_(function () {
    var p = SDC.Logo.parseCell(SDC.Customer.readOne(ss, config, 'customerLogo'));
    return { kind: p.kind, fileId: p.fileId, driveUrl: p.driveUrl, legacyUrl: p.legacyUrl };
  }, null) : null;
  // Required 1_customer fields still blank, by the library's rule (Customer.missingRequired, the one Preflight uses).
  // The logo is left out: it has its own step. Null = cannot tell (older library, or the workbook cannot be read).
  f.customerMissing = config && typeof SDC.Customer.missingRequired === 'function' ? safe_(function () {
    return SDC.Customer.missingRequired(SDC.Customer.read(ss, config))
      .filter(function (m) { return m.type !== 'driveFile'; })
      .map(function (m) { return m.friendly; });
  }, null) : null;
  // Suppliers on 2_suppliers that have a user on 3_users. Null = cannot tell.
  f.invitable = safe_(function () { return suppliersWithUsers_(ss, config); }, null);
  f.provisioned = isProvisioned_(f);
  return f;
}

/**
 * Roster headers, as the template prints them on row 8 of each tab. Two headers per tab on purpose: "Supplier name"
 * also appears on the definition row above (row 6), and findHeaderRow_ returns the first row holding every header asked for.
 */
var GUIDE_ROSTER = {
  suppliers: { name: 'Supplier name', anchor: 'Template variation' },
  users:     { email: 'Supplier user email', supplier: 'Supplier name' }
};

/**
 * How many suppliers on 2_suppliers have at least one user on 3_users. A user counts when its row has an email and
 * its supplier matches a supplier name (trimmed, case-insensitive). Computed here, not read from the sheet's
 * "Number of users" column: that formula is not filled down in the template.
 *
 * This is the workbook's view. Workato holds the real roster, so the count is only right after the last Start / Update.
 *
 * @returns {?number} null when a tab or a header cannot be found.
 */
function suppliersWithUsers_(ss, config) {
  var tabs = config ? config.sheets : { suppliers: '2_suppliers', users: '3_users' };
  var S = GUIDE_ROSTER.suppliers, U = GUIDE_ROSTER.users;
  var sup = headedRows_(ss, tabs.suppliers, [S.name, S.anchor]);
  var usr = headedRows_(ss, tabs.users, [U.email, U.supplier]);
  if (!sup || !usr) return null;

  var hasUser = {};
  usr.rows.forEach(function (r) {
    var supplier = trim_(r[usr.col[U.supplier]]).toLowerCase();
    if (supplier && trim_(r[usr.col[U.email]]) !== '') hasUser[supplier] = true;
  });
  var counted = {}, n = 0;
  sup.rows.forEach(function (r) {
    var name = trim_(r[sup.col[S.name]]).toLowerCase();
    if (name && hasUser[name] && !counted[name]) { counted[name] = true; n++; }
  });
  return n;
}

/** The rows below a tab's header row, plus header text -> column index. null when the tab or the headers are missing. */
function headedRows_(ss, sheetName, requiredHeaders) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  var hr = findHeaderRow_(values, requiredHeaders);
  if (hr === -1) return null;
  return { col: headerMap_(values[hr]), rows: values.slice(hr + 1) };
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
 *   action    - an any-time action, not a step (kind 'action': no marker, no number, never "Next")
 */

function step_(id, phase, title, hint, state, actions, tabs, extra) {
  var s = { id: id, phase: phase, title: title, hint: hint, state: state,
            actions: actions || [], tabs: tabs || [] };
  if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
  return s;
}
/**
 * fn must be a global in this container; the sidebar calls google.script.run[fn]().
 * action, when given, is an SDC.Actions key: the sidebar then runs it in the progress window (guideOpenProgress /
 * guideRun) instead of calling fn, and fn only documents the menu equivalent.
 */
function act_(label, fn, primary, enabled, action) {
  var a = { label: label, fn: fn, primary: !!primary, enabled: enabled !== false };
  if (action) a.action = action;
  return a;
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
    // Ticked from the cells, so a workbook that arrives filled in (created from the implementations app) starts ticked.
    // null = cannot tell (older library, unreadable workbook): the manual step below, as before.
    var missing = f.customerMissing;
    if (missing !== null) {
      return step_('customer', 'Prepare', 'Describe the client',
        missing.length ? 'Still needed in 1_customer: ' + missing.join(', ') + '.'
                       : 'Every required field in 1_customer is filled in.',
        missing.length ? 'todo' : 'done', [], ['1_customer']);
    }
    return step_('customer', 'Prepare', 'Describe the client',
      'Fill in 1_customer, including the supplier manager email (the client-side contact Workato receives with the configuration). Validate (below) checks it; nothing to run here.',
      'manual', [], ['1_customer']);
  },

  function (f) {
    if (!f.logo) return null;                       // library without Logo, or workbook unreadable: nothing to offer
    var m = f.marks['logo'], k = f.logo.kind;
    var hint =
      k === 'drive'   ? 'Uploaded' + (okMark_(m) ? ' ' + when_(m) : '') + '. Choose a new file to replace it.'
      : k === 'legacy'  ? 'The cell holds a public link, the old way. Upload the image file instead; the link is still sent until you do.'
      : k === 'invalid' ? 'The cell holds something that is neither a Drive link nor a web address. Upload the image file.'
      :                   'PNG or JPEG, up to 2 MB. Saved to the engagement’s Drive folder and linked from 1_customer.';
    return step_('logo', 'Prepare', 'Upload the customer logo', hint,
      k === 'drive' ? 'done' : 'todo', [], [], { control: 'logo', logo: f.logo });
  },

  function (f) {
    var m = f.marks['link'];
    if (f.linked) {
      return step_('link', 'Prepare', 'Link to a workspace',
        'Linked to ' + f.workspaceKey + (okMark_(m) ? ' (' + when_(m) + ')' : '') + '. To move it, release it from the implementations app.',
        'done', [], []);
    }
    var ready = !!f.clientName;
    return step_('link', 'Prepare', 'Link to a workspace',
      !f.canLink ? 'This library cannot link from here; use the implementations app.'
      : !ready    ? 'Needs the client name in 1_customer first. Claims a Workato workspace for this workbook and invites the analyst to it.'
      : (m && !okMark_(m)) ? 'Last attempt failed ' + when_(m) + '. Try again, or link from the implementations app.'
      :             'Claims a Workato workspace for this workbook and invites the analyst named in 1_customer. Validate and everything after it need this.',
      ready && f.canLink ? 'todo' : 'blocked',
      [act_('Link\u2026', 'linkWorkspace', true, ready && f.canLink)], ready ? [] : ['1_customer']);
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

  // No "Set up field IDs" step: Validate, Preview, Start, Update and a pack apply all stamp missing IDs
  // (SDC.PrimaryKey.backfill), so the analyst never has to. The menu item stays under "Setup and advanced tools".

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
      !f.linked ? 'Link the workbook to a workspace first.'
      : done ? 'Passed ' + when_(m) + '. Re-validate after any edit.'
           : (m ? 'Last run failed ' + when_(m) + '. Fix the errors and run again.'
                : 'Runs the preflight checks. Fix every error before pushing.'),
      !f.linked ? 'blocked' : done ? 'done' : 'todo',
      [act_('Validate', 'validateConfiguration', true, f.linked, 'validate')], []);
  },

  function (f) {
    var m = f.marks['preview'], done = okMark_(m);
    return step_('preview', 'Check', 'Preview the supplier template',
      !f.linked ? 'Link the workbook to a workspace first.'
      : done ? 'Built ' + when_(m) + '.'
      : m    ? 'Last attempt ' + when_(m) + ' built no file: the configuration was not yet valid. Validate, fix, try again.'
             : 'Optional. Downloads the .xlsx a supplier would receive.',
      !f.linked ? 'blocked' : done ? 'done' : 'optional',
      [act_('Preview\u2026', 'previewTemplate', false, f.linked, 'preview')], []);
  },

  // -- Push to Workato -------------------------------------------------------
  function (f) {
    var m = f.marks['provision:initial'];
    return step_('start', 'Push to Workato', 'Start supplier data collection',
      f.provisioned ? 'First push ' + when_(m) + '. Use Update for later changes.'
      : !f.linked   ? 'Link the workbook to a workspace first.'
                    : 'Sends the configuration to Workato for the first time.',
      f.provisioned ? 'done' : f.linked ? 'todo' : 'blocked',
      f.provisioned ? [] : [act_('Start', 'initializeWorkspace', true, f.linked, 'start')], []);
  },

  // kind 'action' (this entry and "Request portal access" below): not part of the checklist. guideStatus returns
  // them as a separate list, and the sidebar draws them under "Any time" with no number and no tick.
  function (f) {
    var m = f.marks['provision:update'];
    return step_('update', 'Any time', 'Update configuration',
      okMark_(m) ? 'Last update ' + when_(m) + '.'
                 : 'Re-sends the configuration after you change it.',
      f.provisioned ? 'action' : 'blocked',
      [act_('Update', 'updateWorkspace', f.provisioned, f.provisioned, 'update')], [], { kind: 'action' });
  },

  function (f) {
    if (f.invitable === 0) return null;             // no supplier has a user yet: nobody to invite. null (unknown) still shows
    var m = f.marks['invitations'], done = okMark_(m);
    return step_('invitations', 'Push to Workato', 'Send supplier invitations',
      done ? 'Last batch ' + when_(m) + '.' : 'Invites every pending supplier. Needs a started collection.',
      done ? 'done' : (f.provisioned ? 'todo' : 'blocked'),
      [act_('Send invitations', 'sendAllInvitations', f.provisioned, f.provisioned, 'invitations')], []);
  },

  function (f) {
    var m = f.marks['portalInvite'], done = okMark_(m);
    return step_('portal', 'Any time', 'Request portal access',
      done ? 'Requested ' + when_(m) + '.' : 'Gets you (the analyst) into the supplier portal for this application.',
      'action',
      [act_('Request access', 'requestPortalAccess', false)], [], { kind: 'action' });
  }
];
