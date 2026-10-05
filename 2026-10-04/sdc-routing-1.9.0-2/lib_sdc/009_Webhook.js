/**
 * @file 009_Webhook.gs
 * Single HTTP transport for every workbook → Workato call.
 *
 * Since library 1.9.0 a workbook never talks to a client workspace directly. Every call is one shape:
 *
 *   POST <router.baseUrl>/route            header API-TOKEN: <router.apiToken>
 *   { spreadsheet_id, correlation_id, path, is_initial, payload, payload_version }
 *
 * and the router answers HTTP 200 with the envelope { status_code, body }, where status_code and body are whatever
 * the client workspace's endpoint at `path` returned (or the router's own rejection: NOT_REGISTERED, NOT_PROVISIONED,
 * ALREADY_PROVISIONED, WORKSPACE_CLOSED ...). Webhook.call unwraps the envelope so callers see exactly what they saw
 * when they called the workspace directly: { statusCode, body, parsed }.
 *
 * Public:
 *   Webhook.call(config, route, payload, options) → { statusCode, body, parsed }
 *
 *     config   - Config.build(ss) output; router.baseUrl and router.apiToken must be set.
 *     route    - { path, spreadsheetId, correlationId, [isInitial=false] }
 *     payload  - The endpoint's own body (what the workspace recipe's trigger reads). Sent as an opaque JSON string;
 *                payload_version is stamped onto it by the library and cannot be overridden.
 *     options  - { maxAttempts=3, fetchTimeoutSeconds, tolerateErrorStatus=false }
 *
 * Status handling after unwrapping, per attempt:
 *   - 2xx / 3xx             → success, return
 *   - 4xx (≠ 429)           → permanent: throw, unless options.tolerateErrorStatus (validate/preview put their
 *                             verdict in a 400 body) in which case return it
 *   - 429 / 5xx / exception → retry with backoff 1s, 2s, 4s (max 3 attempts total). Callers whose endpoint is not
 *                             idempotent (provision) pass maxAttempts: 1.
 *
 * The router itself always answers 200 (its API endpoint is fixed at 200 and carries the real status inside), so a
 * non-200 from the transport means the router or the API gateway failed, not the workspace; that is reported as
 * a transport error with the raw body, and retried like any 5xx.
 */

var Webhook = {};

var WEBHOOK_MAX_ATTEMPTS  = 3;
var WEBHOOK_BASE_DELAY_MS = 1000;
var WEBHOOK_ROUTE_PATH    = '/route';

Webhook.call = function(config, route, payload, options) {
  if (!config || !config.router) throw new Error('Webhook.call: config with a router block is required.');
  if (!route || !route.path)     throw new Error('Webhook.call: route.path is required.');
  if (!route.spreadsheetId)      throw new Error('Webhook.call: route.spreadsheetId is required.');
  if (!route.correlationId)      throw new Error('Webhook.call: route.correlationId is required.');
  if (!payload)                  throw new Error('Webhook.call: payload is required.');
  Webhook._requireRouter(config);

  var opts        = options || {};
  var maxAttempts = opts.maxAttempts || WEBHOOK_MAX_ATTEMPTS;

  // Library-controlled payload_version (non-spoofable from the caller). Lives on the inner payload, where the
  // workspace recipe reads it, and is repeated on the envelope for the router's logs.
  var inner = {};
  for (var k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) inner[k] = payload[k];
  }
  inner.payload_version = SDC_PAYLOAD_VERSION;

  var envelope = {
    spreadsheet_id:  route.spreadsheetId,
    correlation_id:  route.correlationId,
    path:            route.path,
    is_initial:      Boolean(route.isInitial),
    payload:         JSON.stringify(inner),
    payload_version: SDC_PAYLOAD_VERSION
  };

  var url = config.router.baseUrl.replace(/\/+$/, '') + WEBHOOK_ROUTE_PATH;
  var fetchOptions = {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'API-TOKEN': config.router.apiToken },
    payload:            JSON.stringify(envelope),
    muteHttpExceptions: true
  };
  // Long synchronous forwards (provision) must tell UrlFetchApp to wait; the default is short and undocumented.
  if (opts.fetchTimeoutSeconds) fetchOptions.fetchTimeoutSeconds = opts.fetchTimeoutSeconds;

  var lastError = null;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var transportStatus, transportBody;
    try {
      var response    = UrlFetchApp.fetch(url, fetchOptions);
      transportStatus = response.getResponseCode();
      transportBody   = response.getContentText();
    } catch (e) {
      lastError = new Error('Network exception on attempt ' + (attempt + 1) + ': ' + e.message);
      if (attempt < maxAttempts - 1) { Utilities.sleep(Webhook._backoffMs(attempt)); continue; }
      throw lastError;
    }

    // The router/gateway itself failed (401 bad router token, 404 wrong base URL, 429, 5xx, 504 timeout).
    if (transportStatus < 200 || transportStatus >= 400) {
      var transportErr = Webhook._transportError(transportStatus, transportBody, attempt);
      if (transportStatus >= 400 && transportStatus < 500 && transportStatus !== 429) throw transportErr;
      lastError = transportErr;
      if (attempt < maxAttempts - 1) Utilities.sleep(Webhook._backoffMs(attempt));
      continue;
    }

    var unwrapped = Webhook._unwrap(transportBody);
    var statusCode = unwrapped.statusCode;

    if (statusCode >= 200 && statusCode < 400) return unwrapped;

    if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      if (opts.tolerateErrorStatus) return unwrapped;
      throw Webhook._endpointError(statusCode, unwrapped, route.path);
    }

    lastError = Webhook._endpointError(statusCode, unwrapped, route.path);
    if (attempt < maxAttempts - 1) Utilities.sleep(Webhook._backoffMs(attempt));
  }

  throw new Error('Call to ' + route.path + ' failed after ' + maxAttempts + ' attempt(s). Last error: ' + lastError.message);
};

// --- Private helpers -------------------------------------------------

Webhook._requireRouter = function(config) {
  if (!config.router.baseUrl) {
    throw new Error('Router base URL not configured. Check _developer_settings → router.baseUrl. ' +
      'This workbook must be claimed from the routing workbook before it can talk to Workato.');
  }
  if (!config.router.apiToken) {
    throw new Error('Router API token not configured. Check _developer_settings → router.apiToken.');
  }
};

/**
 * Take the router's 200 body { status_code, body } apart. body is the workspace endpoint's response as a string;
 * it is parsed when it is JSON. A router body that is not the envelope is treated as a 502 so the caller sees a
 * transport problem rather than a silent success.
 */
Webhook._unwrap = function(transportBody) {
  var env = Webhook._tryParseJson(transportBody);
  if (!env || typeof env !== 'object' || env.status_code === undefined || env.status_code === null) {
    return {
      statusCode: 502,
      body:       transportBody,
      parsed:     { error_details: { code: 'BAD_ENVELOPE', errored_action: 'router',
                    error_message: 'Router returned a body without status_code: ' + Webhook._truncate(transportBody, 300) } }
    };
  }
  var body = env.body === null || env.body === undefined ? '' : String(env.body);
  return { statusCode: Number(env.status_code), body: body, parsed: Webhook._tryParseJson(body) };
};

/**
 * One readable Error for a non-success status from the workspace endpoint or the router. Prefers the
 * error_details envelope both sides use ({code, error_message, errored_action}); falls back to the raw body.
 */
Webhook._endpointError = function(statusCode, unwrapped, path) {
  var d = unwrapped.parsed && unwrapped.parsed.error_details;
  var msg;
  if (d && (d.error_message || d.code)) {
    msg = (d.code ? '[' + d.code + '] ' : '') + (d.error_message || '') +
          (d.errored_action ? ' (' + d.errored_action + ')' : '');
  } else if (unwrapped.parsed && unwrapped.parsed.error) {
    msg = String(unwrapped.parsed.error);
  } else {
    msg = Webhook._truncate(unwrapped.body, 500);
  }
  var err = new Error('HTTP ' + statusCode + ' from ' + path + ': ' + msg);
  err.statusCode = statusCode;
  err.errorCode  = d && d.code ? d.code : null;
  return err;
};

Webhook._transportError = function(status, body, attempt) {
  var hint = '';
  if (status === 401) hint = ' Router API token rejected; check _developer_settings → router.apiToken.';
  if (status === 404) hint = ' Router base URL did not resolve; check _developer_settings → router.baseUrl.';
  if (status === 504) hint = ' The router timed out waiting for the workspace; the forward may still be running.';
  return new Error('Router HTTP ' + status + ' on attempt ' + (attempt + 1) + ': ' + Webhook._truncate(body, 300) + hint);
};

Webhook._backoffMs = function(attempt) {
  return Math.pow(2, attempt) * WEBHOOK_BASE_DELAY_MS;
};
Webhook._tryParseJson = function(body) {
  if (!body) return null;
  try { return JSON.parse(body); } catch (e) { return null; }
};
Webhook._truncate = function(s, max) {
  s = String(s || '');
  return s.length > max ? s.substring(0, max) + '…' : s;
};
