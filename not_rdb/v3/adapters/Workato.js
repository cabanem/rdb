/**
 * @file adapters/Workato.gs — push to the Workato API endpoint using
 * Workato's native Auth Token method.
 *
 * Auth model: the access-profile token is sent in the `api-token` header, and
 * Workato's API gate matches it to the access profile BEFORE the recipe runs.
 * No HMAC, no timestamps, no signing. The platform owns authentication, and
 * rotation is the Refresh button on the Clients page plus one Script Property
 * update — no dual-accept window, no recipe formula.
 *
 * The token lives in Script Property WORKATO_WEBHOOK_SECRET. The property NAME
 * is kept for continuity; its VALUE is now the Workato Auth Token shown once
 * when the access profile was created — not an openssl-generated HMAC secret.
 *
 * Retired from the previous version: signPush_, the X-Timestamp and X-Signature
 * headers, and the HMAC verification branch inside the recipe.
 */

/** @const {string} Script Property holding the Workato Auth Token. */
const WORKATO_SECRET_PROP = 'WORKATO_WEBHOOK_SECRET';

/** @const {string} The header Workato's Auth Token method reads. */
const WORKATO_TOKEN_HEADER = 'api-token';

/**
 * The Workato Auth Token from Script Properties.
 * @return {string}
 * @throws {Error} If the property is unset.
 * @private
 */
function workatoSecret_() {
  const s = PropertiesService.getScriptProperties().getProperty(WORKATO_SECRET_PROP);
  if (!s) throw new Error('Script Property ' + WORKATO_SECRET_PROP + ' is not set.');
  return s;
}

/**
 * Request headers for one push: the auth token plus a correlation id for
 * Workato job search. The body's correlation_id remains authoritative.
 * @param {string} correlationId
 * @return {Object.<string,string>}
 * @private
 */
function workatoHeaders_(correlationId) {
  const h = { 'X-Correlation-Id': correlationId };
  h[WORKATO_TOKEN_HEADER] = workatoSecret_();
  return h;
}

/**
 * Raw POST to Workato. Returns status + body and never throws on HTTP status
 * (only on transport failure), so callers and tests can inspect any outcome.
 * @param {string} url
 * @param {Object} payload JSON-serializable body.
 * @param {Object.<string,string>} headers
 * @return {{code:number, body:string}}
 * @private
 */
function sendToWorkato_(url, payload, headers) {
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), body: resp.getContentText() };
}

/**
 * Production push: send, throw on non-2xx so the sheet stays in pending.
 * @param {Approval} approval
 * @param {Config} cfg
 * @param {Object.<string,*>} [typedFields] Label -> typed value from the gate (Gate.gs). Omit to send raw cells.
 * @throws {Error} On any non-2xx response, with the recipe's own message when the body carries one.
 * @private
 */
function pushToWorkato_(approval, cfg, typedFields) {
  const r = sendToWorkato_(cfg.workato_webhook_url, buildPayload_(approval, cfg, typedFields),
    workatoHeaders_(approval.correlationId));
  if (r.code < 200 || r.code >= 300) throw new Error(workatoErrorText_(r.code, r.body));
}

/**
 * One line for the Last error cell from a non-2xx response. Prefers the recipe's structured body — `message`
 * (the Salesforce or catch message first, per the recipe's response design) and `field` when it names one — and
 * falls back to the raw body, truncated. Pure.
 * @param {number} code
 * @param {string} body
 * @return {string}
 * @private
 */
function workatoErrorText_(code, body) {
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
  if (json && json.message) {
    return 'Workato ' + code + ': ' + (json.field ? json.field + ' — ' : '') + String(json.message).slice(0, 400);
  }
  return 'Workato ' + code + ': ' + String(body || '').slice(0, 300);
}

// --- OPPORTUNITY SEARCH ---------------------------------------------------------------------------
/** @const {number} Most suggestions put in the Opportunity dropdown. The endpoint already caps at 25. */
const WORKATO_SEARCH_MAX = 25;

/**
 * Candidate opportunities for a new review sheet, from the `/search-opportunities` endpoint. Best effort by
 * design: any failure (no URL configured, transport, non-200, odd body) returns [] after a WARN log, so a search
 * outage can never stop a contract from being staged — the reviewer still has the paste-an-Id path.
 * @param {Config} cfg Supplies workato_search_url.
 * @param {string} corr The sheet's correlation id (also the endpoint's cache key, with the query).
 * @param {string} query The extracted text to search on (typically the account name). Blank = no call.
 * @return {Array<{id:string,label:string}>}
 * @private
 */
function fetchOpportunityCandidates_(cfg, corr, query) {
  const q = str_(query);
  if (!cfg.workato_search_url || !q) return [];
  try {
    const url = cfg.workato_search_url + (cfg.workato_search_url.indexOf('?') === -1 ? '?' : '&') +
      'correlation_id=' + encodeURIComponent(corr) + '&account_query=' + encodeURIComponent(q);
    const resp = UrlFetchApp.fetch(url, { method: 'get', headers: workatoHeaders_(corr), muteHttpExceptions: true });
    let json = null;
    try { json = JSON.parse(resp.getContentText()); } catch (e) { /* not JSON; interpret below */ }
    return interpretSearchResponse_(resp.getResponseCode(), json);
  } catch (err) {
    logWarn_('fetchOpportunityCandidates_', 'Opportunity search skipped', corr, err.message);
    return [];
  }
}

/**
 * Pure interpretation of the search response: the candidate list on a 200 with ok:true, else a throw naming the
 * problem (the caller turns that into [] + a warning). Entries without an Id are dropped.
 * @param {number} code HTTP status.
 * @param {?Object} json Parsed body, or null when it was not JSON.
 * @return {Array<{id:string,label:string}>}
 * @throws {Error} On non-200, ok:false, or a body that is not JSON.
 * @private
 */
function interpretSearchResponse_(code, json) {
  if (!json) throw new Error('Search endpoint ' + code + ': response is not JSON.');
  if (code !== 200) throw new Error('Search endpoint ' + code + ': ' + (json.message || JSON.stringify(json)).slice(0, 300));
  if (json.ok === false) throw new Error('Search endpoint: ' + (json.message || 'ok=false'));
  return (Array.isArray(json.candidates) ? json.candidates : [])
    .filter(function (c) { return c && str_(c.id); })
    .slice(0, WORKATO_SEARCH_MAX)
    .map(function (c) { return { id: str_(c.id), label: str_(c.label) || str_(c.id) }; });
}

/**
 * The dropdown text for one candidate: the human label with the Id appended in brackets, so the chosen option
 * carries its own Id and the gate reads it back with the same regex it uses for a pasted URL — no hidden
 * label -> Id map in the sheet. Pure.
 * @param {{id:string,label:string}} c
 * @return {string}
 * @private
 */
function candidateOption_(c) {
  return c.label + ' [' + c.id + ']';
}
