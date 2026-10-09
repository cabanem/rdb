/**
 * Sources.gs — the three discovery phases. Each takes (cfg, state, store, deadline)
 * and returns true when finished, false when it ran out of time budget (state holds the cursor).
 */

const SCRIPT_MIME = 'application/vnd.google-apps.script';

/** Minimal authenticated GET returning parsed JSON. Throws with status + body excerpt on error. */
function api_(url, params) {
  const qs = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');

  const res = UrlFetchApp.fetch(qs ? `${url}?${qs}` : url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code >= 300) throw new Error(`${code} from ${url}: ${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText() || '{}');
}

// ---------------------------------------------------------------------------
// Phase 1: standalone projects visible to Drive
// ---------------------------------------------------------------------------
function scanDrive_(cfg, state, store, deadline) {
  const q = [`mimeType = '${SCRIPT_MIME}'`, 'trashed = false'];
  if (!cfg.INCLUDE_SHARED_WITH_ME) q.push("'me' in owners"); // note: shared-drive files have no owners

  do {
    const page = api_('https://www.googleapis.com/drive/v3/files', {
      q: q.join(' and '),
      fields: 'nextPageToken,files(id,name,owners(emailAddress),modifiedTime,webViewLink,driveId,sharedWithMeTime)',
      pageSize: 200,
      pageToken: state.driveToken,
      corpora: cfg.INCLUDE_SHARED_DRIVES ? 'allDrives' : 'user',
      supportsAllDrives: true,
      includeItemsFromAllDrives: cfg.INCLUDE_SHARED_DRIVES,
    });

    (page.files || []).forEach(f => upsert_(store, f.id, {
      scriptId: f.id,
      name: f.name,
      kind: 'standalone',
      owner: f.driveId ? '(shared drive)' : (f.owners || []).map(o => o.emailAddress).join(', '),
      modified: f.modifiedTime,
      location: f.driveId ? 'shared drive' : f.sharedWithMeTime ? 'shared with me' : 'my drive',
      link: f.webViewLink,
      manifestStatus: '',          // force re-read of the manifest this run
      lastSeen: state.runId,
    }));

    state.driveToken = page.nextPageToken;
  } while (state.driveToken && Date.now() < deadline);

  return !state.driveToken;
}

// ---------------------------------------------------------------------------
// Phase 2: manifests via Drive export (no Apps Script API needed)
// ---------------------------------------------------------------------------
function scanManifests_(cfg, state, store, deadline) {
  if (!cfg.FETCH_MANIFESTS) return true;

  for (const row of store.rows.values()) {
    if (row.kind !== 'standalone' || row.manifestStatus) continue; // the sheet is the work queue
    if (Date.now() > deadline) return false;

    try {
      Object.assign(row, fetchManifest_(row.scriptId), { manifestStatus: 'ok' });
    } catch (e) {
      row.manifestStatus = 'error: ' + String(e.message).slice(0, 150);
    }
  }
  return true;
}

function fetchManifest_(scriptId) {
  const project = api_(`https://www.googleapis.com/drive/v3/files/${scriptId}/export`, {
    mimeType: SCRIPT_MIME + '+json',
  });
  const file = (project.files || []).find(f => f.name === 'appsscript');
  if (!file) throw new Error('export contained no appsscript.json');

  const manifest = JSON.parse(file.source);
  const deps = manifest.dependencies || {};
  return {
    libraries: (deps.libraries || [])
      .map(l => `${l.userSymbol}@${l.version}${l.developmentMode ? ' (dev)' : ''}  [${l.libraryId}]`)
      .join('\n'),
    advancedServices: (deps.enabledAdvancedServices || [])
      .map(s => `${s.userSymbol} ${s.version}`)
      .join('\n'),
    oauthScopes: (manifest.oauthScopes || [])
      .map(s => s.replace('https://www.googleapis.com/auth/', ''))
      .join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Phase 3: execution history (Apps Script API). Processes carry project NAME, not ID.
// Attached to a standalone row when exactly one row has that name; otherwise a
// name-keyed row is created so bound / add-on / unlisted projects still appear.
// ---------------------------------------------------------------------------
function scanExecutions_(cfg, state, store, deadline) {
  if (!cfg.SCAN_EXECUTIONS) return true;

  if (!state.execStarted) {                     // zero counters once per run, not per chunk
    for (const row of store.rows.values()) {
      row.executionCount = 0; row.lastExecution = ''; row.executionTypes = '';
    }
    state.execStarted = true;
  }

  const since = new Date(Date.now() - cfg.EXECUTION_LOOKBACK_DAYS * 864e5).toISOString();
  const byName = indexByName_(store);

  do {
    const page = api_('https://script.googleapis.com/v1/processes', {
      pageSize: 100,
      pageToken: state.procToken,
      'userProcessFilter.startTime': since,
    });

    (page.processes || []).forEach(p => {
      const candidates = byName.get(p.projectName) || [];
      const row = candidates.length === 1
        ? candidates[0]
        : upsert_(store, 'name:' + p.projectName, {
            name: p.projectName,
            kind: 'executed only (bound, add-on, or not visible in Drive)',
            lastSeen: state.runId,
          });

      const types = new Set(String(row.executionTypes || '').split(', ').filter(Boolean));
      types.add(p.processType);
      row.executionTypes = [...types].join(', ');
      row.executionCount = (Number(row.executionCount) || 0) + 1;
      if (iso_(p.startTime) > iso_(row.lastExecution)) row.lastExecution = p.startTime;
    });

    state.procToken = page.nextPageToken;
  } while (state.procToken && Date.now() < deadline);

  return !state.procToken;
}
