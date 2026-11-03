/**
 * @file adapters/Vertex.gs
 * Everything that talks to Vertex AI: the generateContent call for extraction and the publisher-models catalogue.
 * vertexToken_() is the only place the calling identity is decided. interpretGeminiResponse_, extractSources_,
 * parseModelList_, dedupeModels_, vertexIdentity_ and interpretMintResponse_ are pure.
 *
 * IDENTITY
 *   Drive access and model access are separate concerns. Drive is always the runner (the trigger owner); the
 *   model call is the runner too UNLESS Config names a service account in `vertex_service_account`, in which case
 *   the runner impersonates it: one generateAccessToken call to the IAM Credentials API, authenticated with the
 *   runner's own token, returns a short-lived token for the service account, and every Vertex call carries that.
 *   Blank key = exactly today's behaviour, so the switch is reversible from the Config sheet with no deploy.
 *
 *   What the switch needs, outside this code:
 *     - roles/iam.serviceAccountTokenCreator for the runner ON the service account (not on the project).
 *     - roles/aiplatform.user for the service account on `project_id`.
 *     - The IAM Credentials API enabled on `project_id`, and the runner allowed to bill quota to it
 *       (roles/serviceusage.serviceUsageConsumer) — the mint names it in x-goog-user-project, which is what makes
 *       the call work from a sandboxed Apps Script project.
 *   checkVertexAccess() (entrypoints/Tools.gs) proves all of that in one run before any contract depends on it.
 */

// --- IDENTITY ------------------------------------------------------------------------------------
/** @const {string} IAM Credentials endpoint; `-` for the project means "look the account up by email". */
const VERTEX_MINT_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/';
/** @const {string} Scope minted for the service account. cloud-platform covers Vertex and Model Garden. */
const VERTEX_MINT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** @const {string} Lifetime requested for a minted token. One run never needs more than a few minutes. */
const VERTEX_MINT_LIFETIME = '600s';

/**
 * Minted token, cached for the duration of one execution (globals reset per run). One mint per poll, not per file.
 * @type {?{email:string, token:string}}
 */
var vertexMintCache_ = null;

/**
 * Who Vertex calls run as, decided from Config alone. Pure.
 * @param {Config} cfg
 * @return {{mode:'runner'}|{mode:'service_account', email:string}}
 * @private
 */
function vertexIdentity_(cfg) {
  const email = String((cfg && cfg.vertex_service_account) || '').trim();
  return email ? { mode: 'service_account', email: email } : { mode: 'runner' };
}

/**
 * The bearer token every Vertex call uses: the runner's own OAuth token, or a token minted for the configured
 * service account by impersonating it as the runner. This is the only place the calling identity is decided.
 * @param {Config} cfg
 * @return {string}
 * @throws {Error} If a mint is required and fails; the message names the service account and the HTTP status.
 * @private
 */
function vertexToken_(cfg) {
  const who = vertexIdentity_(cfg);
  if (who.mode === 'runner') return ScriptApp.getOAuthToken();
  if (vertexMintCache_ && vertexMintCache_.email === who.email) return vertexMintCache_.token;
  const token = mintServiceAccountToken_(who.email, cfg.project_id);
  vertexMintCache_ = { email: who.email, token: token };
  return token;
}

/**
 * Impersonate a service account from Apps Script: POST generateAccessToken as the runner. The quota project
 * header is required when the Apps Script project's own Cloud project cannot be used (the usual case here).
 * @param {string} email Service account email.
 * @param {string} quotaProject Project that has the IAM Credentials API enabled and bills the call.
 * @return {string} Access token for the service account.
 * @throws {Error} On a non-200 response or a body without accessToken.
 * @private
 */
function mintServiceAccountToken_(email, quotaProject) {
  const resp = UrlFetchApp.fetch(VERTEX_MINT_URL + encodeURIComponent(email) + ':generateAccessToken', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': quotaProject },
    payload: JSON.stringify({ scope: [VERTEX_MINT_SCOPE], lifetime: VERTEX_MINT_LIFETIME }),
    muteHttpExceptions: true
  });
  let json = null;
  try { json = JSON.parse(resp.getContentText()); } catch (e) { json = {}; }
  return interpretMintResponse_(resp.getResponseCode(), json, email);
}

/**
 * Pure interpretation of a generateAccessToken response. Never returns a token it did not get.
 * @param {number} code HTTP status.
 * @param {Object} json Parsed body ({accessToken, expireTime} on success; {error:{message}} otherwise).
 * @param {string} email For the error message.
 * @return {string}
 * @throws {Error}
 * @private
 */
function interpretMintResponse_(code, json, email) {
  if (code !== 200) {
    throw new Error('Could not mint a token for ' + email + ' (IAM Credentials ' + code + '): ' +
      ((json && json.error && json.error.message) || JSON.stringify(json)) +
      '. The runner needs roles/iam.serviceAccountTokenCreator on that account.');
  }
  if (!json || !json.accessToken) throw new Error('IAM Credentials returned no accessToken for ' + email + '.');
  return json.accessToken;
}

// --- EXTRACTOR -----------------------------------------------------------------------------------
/**
 * The Vertex-backed {@link Extractor}: the pipeline's default. A factory rather than a top-level constant so no
 * file-load order is assumed. processIngestion() builds one per run and hands it down.
 * @return {Extractor}
 * @private
 */
function vertexExtractor_() {
  return { extract: callGemini_ };
}

// --- GENERATECONTENT -----------------------------------------------------------------------------
/**
 * Vertex seam. Builds the request, fires it, and delegates response interpretation to {@link interpretGeminiResponse_}
 * (kept pure so the branch logic is unit-testable). Auth is whatever vertexToken_(cfg) decides.
 * @param {Config} cfg
 * @param {string} promptText Prompt that precedes the file content parts.
 * @param {ContentPart[]} contentParts File content (text or inline document).
 * @return {GeminiResult}
 * @throws {Error} On transport or non-text outcomes (safety/recitation/empty).
 * @private
 */
function callGemini_(cfg, promptText, contentParts) {
  if (!cfg.project_id) throw new Error('Config missing "project_id".');
  const location = cfg.location || 'global';
  const model = cfg.model || 'gemini-2.5-pro';
  const host = (location === 'global')
    ? 'aiplatform.googleapis.com'
    : location + '-aiplatform.googleapis.com';
  const url = 'https://' + host + '/v1/projects/' + cfg.project_id +
    '/locations/' + location + '/publishers/google/models/' +
    model + ':generateContent';

  const body = {
    contents: [{ role: 'user', parts: [{ text: promptText }].concat(contentParts) }],
    generationConfig: {
      temperature: (cfg.temperature == null ? 0.2 : cfg.temperature),
      maxOutputTokens: (cfg.max_tokens == null ? 8192 : cfg.max_tokens)
    }
  };
  if (cfg.system_instruction) body.systemInstruction = { parts: [{ text: cfg.system_instruction }] };
  if (cfg.grounding) body.tools = [{ googleSearch: {} }];

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + vertexToken_(cfg) },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var json = JSON.parse(resp.getContentText());
  return interpretGeminiResponse_(resp.getResponseCode(), json, cfg.grounding_debug);
}

/**
 * Pure interpretation of a Vertex generateContent response. Throws on non-text
 * outcomes so a blocked/empty extraction is NOT silently staged as a clean one
 * (the "no poison success" guarantee).
 * @param {number} code HTTP status code.
 * @param {Object} json Parsed response body.
 * @param {boolean} groundingDebug Whether to surface a grounding key dump.
 * @return {GeminiResult}
 * @throws {Error} On non-200, no candidates, SAFETY, RECITATION, or empty text.
 * @private
 */
function interpretGeminiResponse_(code, json, groundingDebug) {
  if (code !== 200) {
    throw new Error('Vertex ' + code + ': ' +
      ((json.error && json.error.message) || JSON.stringify(json)));
  }
  var cand = json.candidates && json.candidates[0];
  if (!cand) throw new Error('Gemini returned no candidates.');
  if (cand.finishReason === 'SAFETY') throw new Error('Gemini blocked: safety.');
  if (cand.finishReason === 'RECITATION') throw new Error('Gemini blocked: recitation.');
  var text = ((cand.content && cand.content.parts) || [])
    .map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  var debug = groundingDebug
    ? (cand.groundingMetadata
      ? 'keys=' + JSON.stringify(Object.keys(cand.groundingMetadata))
      : '(no groundingMetadata)')
    : '';
  return { text: text, sources: extractSources_(cand.groundingMetadata), debug: debug };
}

/**
 * Flatten grounding chunks to "title — uri" lines, deduped by uri.
 * @param {Object} meta The candidate's groundingMetadata (may be undefined).
 * @return {string} One source per line, or '' if ungrounded.
 * @private
 */
function extractSources_(meta) {
  const chunks = meta && meta.groundingChunks;
  if (!chunks || !chunks.length) return '';
  const seen = {};
  const lines = [];
  chunks.forEach(function (c) {
    const w = c && c.web;
    if (w && w.uri && !seen[w.uri]) {
      seen[w.uri] = true;
      lines.push((w.title || w.uri) + ' — ' + w.uri);
    }
  });
  return lines.join('\n');
}

// --- MODEL CATALOGUE -----------------------------------------------------------------------------
/** @const {RegExp} Gemini variants that cannot do text/document extraction; excluded from the dropdown. */
const MODEL_EXCLUDE = /embedding|tts|image|live|audio|native|computer-use|robotics/i;

/** @const {number} Safety cap on catalogue pages. */
const MODELS_MAX_PAGES = 10;

/**
 * Call Model Garden for Google's publisher models at the pipeline's location and reduce them to usable Gemini ids.
 * Uses the same identity as callGemini_ (vertexToken_) and names the project for quota.
 * @param {Config} cfg
 * @return {Array<{id:string, stage:string, version:string}>}
 * @throws {Error} On a non-200 response, with the first part of Vertex's message.
 * @private
 */
function listPublisherModels_(cfg) {
  const location = cfg.location || 'global';
  const host = (location === 'global') ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
  const base = 'https://' + host + '/v1beta1/publishers/google/models?listAllVersions=false&pageSize=200';
  const headers = { Authorization: 'Bearer ' + vertexToken_(cfg) };
  if (cfg.project_id) headers['x-goog-user-project'] = cfg.project_id;

  let all = [];
  let token = '';
  for (let page = 0; page < MODELS_MAX_PAGES; page++) {
    const resp = UrlFetchApp.fetch(base + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { headers: headers, muteHttpExceptions: true });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code !== 200) throw new Error('Vertex ' + code + ' listing publisher models: ' + body.slice(0, 300));
    const json = JSON.parse(body);
    all = all.concat(parseModelList_(json));
    token = json.nextPageToken || '';
    if (!token) break;
  }
  return dedupeModels_(all);
}

/**
 * Reduce one page of the publisher-models response to Gemini models fit for text/document generateContent. Pure.
 * Keeps: name starts with "gemini", launch stage not deprecated, not an embedding/TTS/image/live/audio variant.
 * @param {{publisherModels:Array<Object>}} json One page of the API response.
 * @return {Array<{id:string, stage:string, version:string}>} Sorted by id.
 * @private
 */
function parseModelList_(json) {
  const items = (json && json.publisherModels) || [];
  const out = [];
  items.forEach(function (m) {
    const id = String((m && m.name) || '').split('/').pop().trim();
    const stage = String((m && m.launchStage) || '');
    if (!/^gemini/i.test(id)) return;
    if (/DEPRECATED/i.test(stage)) return;
    if (MODEL_EXCLUDE.test(id)) return;
    out.push({ id: id, stage: stage || 'UNKNOWN', version: String((m && m.versionId) || '') });
  });
  return dedupeModels_(out);
}

/**
 * Unique by id, sorted so GA models come first and each stage is alphabetical. Pure.
 * @param {Array<{id:string, stage:string, version:string}>} models
 * @return {Array<{id:string, stage:string, version:string}>}
 * @private
 */
function dedupeModels_(models) {
  const seen = {};
  const out = models.filter(function (m) { if (seen[m.id]) return false; seen[m.id] = true; return true; });
  const rank = function (s) { return s === 'GA' ? 0 : (/PREVIEW/i.test(s) ? 1 : 2); };
  out.sort(function (a, b) { return rank(a.stage) - rank(b.stage) || a.id.localeCompare(b.id); });
  return out;
}
