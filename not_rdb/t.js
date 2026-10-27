/**
 * Identity spike (task-list step 19). Standalone scratch project; nothing here touches the pipeline.
 * Fill SPIKE, run spike(), read the Execution log. The last line is the verdict.
 *
 * Probes, in order (each stops the chain on a failure it can name):
 *   0  runner token: scope + the sandbox project number behind this script
 *   1  control: Vertex with the runner token (today's path) — proves the environment is otherwise healthy
 *   2  mint an SA token, no quota header
 *   3  mint an SA token with x-goog-user-project
 *   4  prove the principal: tokeninfo on the SA token must say email = SA
 *   5  Vertex with the SA token
 *
 * Verdicts:
 *   A  impersonate works as-is                          -> option 1, extractor_getToken_ is ~10 lines
 *   B  impersonate works with x-goog-user-project       -> option 1, plus the header + serviceUsageConsumer
 *   FIX <grant>                                         -> not a verdict yet; make the grant, wait ~2 min, rerun
 *   C  mint blocked in a way no grant fixes             -> option 2 (service behind the SA)
 *
 * Re-run after any IAM change: grants take 1–7 minutes to propagate.
 */

const SPIKE = {
  sa: 'g2s-extractor@YOUR-PROJECT.iam.gserviceaccount.com',   // Phase 4 step 16
  project: 'YOUR-PROJECT',                                    // dedicated Vertex project (step 15)
  location: 'global',
  model: 'gemini-2.5-flash'                                   // cheapest model that exists at `location`
};

function spike() {
  const L = function (s) { Logger.log(s); };
  const runnerToken = ScriptApp.getOAuthToken();

  // 0 — runner token
  const ti = tokenInfo_(runnerToken);
  const sandbox = String(ti.azp || ti.aud || '').split('-')[0];
  L('0 runner token: scope has cloud-platform = ' + /cloud-platform/.test(ti.scope || '') +
    ' | sandbox project number ≈ ' + sandbox + ' | user = ' + (ti.email || '?'));
  if (!/cloud-platform/.test(ti.scope || '')) { L('VERDICT: FIX manifest — add https://www.googleapis.com/auth/cloud-platform and re-authorize'); return; }

  // 1 — control
  const ctl = vertex_(runnerToken, null);
  L('1 control (runner -> Vertex): ' + fmt_(ctl));
  if (ctl.code !== 200 && ctl.code !== 429) { L('VERDICT: environment unhealthy — ' + vertexFix_(ctl) + '. Fix this before judging identity.'); return; }

  // 2 — mint, plain
  const m1 = mint_(runnerToken, null);
  L('2 mint (no header): ' + fmt_(m1));
  let saToken = m1.code === 200 ? m1.json.accessToken : null;
  let route = 'A';

  // 3 — mint, with quota header
  if (!saToken) {
    const d1 = mintFix_(m1, sandbox);
    if (d1.kind !== 'quota') { L('VERDICT: ' + d1.text); return; }
    const m2 = mint_(runnerToken, { 'x-goog-user-project': SPIKE.project });
    L('3 mint (x-goog-user-project): ' + fmt_(m2));
    if (m2.code === 200) { saToken = m2.json.accessToken; route = 'B'; }
    else {
      const d2 = mintFix_(m2, sandbox);
      L('VERDICT: ' + (d2.kind === 'quota' ? 'C — the sandbox quota project cannot be overridden here; go to option 2' : d2.text));
      return;
    }
  }

  // 4 — whose token is it
  const sti = tokenInfo_(saToken);
  L('4 SA token principal: ' + (sti.email || '(none)') + ' | expires in ' + (sti.expires_in || '?') + 's');
  if (String(sti.email || '').toLowerCase() !== SPIKE.sa.toLowerCase()) {
    L('VERDICT: FIX — tokeninfo reports "' + (sti.email || 'no email') + '", expected ' + SPIKE.sa + ' (mint itself succeeded)'); return;
  }

  // 5 — Vertex as the SA
  const v = vertex_(saToken, null);
  L('5 SA -> Vertex: ' + fmt_(v));
  if (v.code === 200 || v.code === 429) {
    L('VERDICT: ' + route + ' — impersonation works' + (route === 'B' ? ' with x-goog-user-project on the mint call' : '') +
      '. Check Cloud Logging on ' + SPIKE.project + ' for principalEmail=' + SPIKE.sa + ' at ' + new Date().toISOString());
  } else {
    L('VERDICT: FIX — ' + vertexFix_(v) + ' (mint route ' + route + ' is fine)');
  }
}

// --- probes ---------------------------------------------------------------------------------

function mint_(runnerToken, extraHeaders) {
  return http_('post',
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + encodeURIComponent(SPIKE.sa) + ':generateAccessToken',
    runnerToken, extraHeaders,
    // userinfo.email is spike-only: it makes tokeninfo report the principal (probe 4). Production mints cloud-platform alone.
    { scope: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email'], lifetime: '600s' });
}

function vertex_(token, extraHeaders) {
  const host = SPIKE.location === 'global' ? 'aiplatform.googleapis.com' : SPIKE.location + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + SPIKE.project + '/locations/' + SPIKE.location +
    '/publishers/google/models/' + SPIKE.model + ':generateContent';
  return http_('post', url, token, extraHeaders,
    { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 64 } });
}

function tokenInfo_(token) {
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  try { return JSON.parse(r.getContentText()); } catch (e) { return {}; }
}

function http_(method, url, token, extraHeaders, body) {
  const headers = { Authorization: 'Bearer ' + token };
  Object.keys(extraHeaders || {}).forEach(function (k) { headers[k] = extraHeaders[k]; });
  const r = UrlFetchApp.fetch(url, { method: method, headers: headers, contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
  let json = {}; try { json = JSON.parse(r.getContentText()); } catch (e) { json = { raw: r.getContentText().slice(0, 300) }; }
  const err = json.error || {};
  return {
    code: r.getResponseCode(), json: json,
    message: String(err.message || json.raw || ''),
    reasons: (err.details || []).map(function (d) { return d.reason; }).filter(Boolean)   // ErrorInfo.reason: deterministic
  };
}

// --- diagnosis ------------------------------------------------------------------------------

/** Classify a failed mint. kind 'quota' means "retry with the header / option 2"; anything else is a named grant. */
function mintFix_(r, sandbox) {
  const has = function (x) { return r.reasons.indexOf(x) !== -1; };
  if (has('SERVICE_DISABLED')) {
    const onSandbox = sandbox && r.message.indexOf(sandbox) !== -1;
    return onSandbox
      ? { kind: 'quota', text: 'IAM Credentials API not enabled on the sandbox project ' + sandbox }
      : { kind: 'grant', text: 'FIX — enable iamcredentials.googleapis.com on ' + SPIKE.project };
  }
  if (has('USER_PROJECT_DENIED')) return { kind: 'grant', text: 'FIX — grant the runner roles/serviceusage.serviceUsageConsumer on ' + SPIKE.project };
  if (has('IAM_PERMISSION_DENIED') || /getAccessToken/.test(r.message)) return { kind: 'grant', text: 'FIX — grant the runner roles/iam.serviceAccountTokenCreator on ' + SPIKE.sa + ' (or wait for propagation)' };
  if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) return { kind: 'grant', text: 'FIX — runner token lacks cloud-platform scope; re-authorize' };
  if (r.code === 404) return { kind: 'grant', text: 'FIX — service account not found; check SPIKE.sa' };
  return { kind: 'other', text: 'C? — unclassified mint failure ' + fmt_(r) + '; read the message before choosing option 2' };
}

function vertexFix_(r) {
  const has = function (x) { return r.reasons.indexOf(x) !== -1; };
  if (has('SERVICE_DISABLED')) return 'enable aiplatform.googleapis.com on ' + SPIKE.project;
  if (has('IAM_PERMISSION_DENIED') || r.code === 403) return 'grant roles/aiplatform.user on ' + SPIKE.project + ' to the calling principal';
  if (r.code === 404) return 'model/location mismatch: ' + SPIKE.model + ' @ ' + SPIKE.location;
  return 'unclassified: ' + fmt_(r);
}

function fmt_(r) {
  return r.code + (r.reasons.length ? ' [' + r.reasons.join(',') + ']' : '') + (r.message ? ' ' + r.message.slice(0, 160) : '');
}
