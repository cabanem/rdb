/**
 * @file 004_Portal.gs
 * Portal-invite orchestrator - the "Request portal access" flow.
 *
 * Slim by design. Does not serialize config or touch Drive. Recovers
 * the most recent SUCCESS correlation ID from _script_logs so the
 * invite can be tied back to its originating provision in Workato.
 *
 * Pipeline:
 *   Config.build -> Portal._preflight -> Log.getMostRecentCorrelationId ->
 *   Payload.portalInvite -> Webhook.call
 *
 * Uses an ad-hoc preflight (Portal._preflight) instead of Preflight.run.
 * Preflight.run is "can I serialize and ship config?" - Portal isn't
 * doing that, and the checks differ in kind (no connector sheet
 * verification, no integration account share verification).
 *
 * Correlation ID handling:
 *   The invite carries the originating provision's correlation ID, not
 *   a fresh one - the whole point of the invite is to reference the
 *   provision it follows. When recovery FAILS (no prior provision in
 *   _script_logs), the flow generates a tracing-only correlation ID for
 *   THIS run's log lines and surfaces null on the Result - the user
 *   should see "no correlation ID" rather than a synthetic UUID that
 *   ties to nothing in Workato.
 *
 * Public:
 *   Portal.run(ss) -> Result
 */

var Portal = {};

Portal.run = function(ss) {
  if (!ss) throw new Error('Portal.run: ss is required.');

  // Recover the originating provision's correlation ID up-front. If absent, we still need SOMETHING to 
  // thread through this run's log lines so they correlate with each other. That tracing ID never
  // ends up on the Result - it dies with the failure log entry.
  var recoveredCorrelationId = Log.getMostRecentCorrelationId(ss);
  var traceCorrelationId     = recoveredCorrelationId || Util.newCorrelationId();
  var log = Log.forCorrelation(ss, traceCorrelationId);

  log('INFO', recoveredCorrelationId
    ? 'Starting portal invite (correlation: ' + recoveredCorrelationId + ')...'
    : 'Starting portal invite (no prior provision found; using tracing-only ID)...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    Stage.run('preflight', function() {
      Portal._preflight(config);
    });

    if (!recoveredCorrelationId) {
      var err = new Error(
        'No completed workspace initialization found in _script_logs. ' +
        'Run "Start supplier data collection" first.'
      );
      err.stage = 'correlation-lookup';
      throw err;
    }

    var userEmail = Util.getActiveUserEmail('');
    if (!userEmail) {
      var emailErr = new Error(
        'Could not resolve your email address. Ensure you are signed in with a Google account.'
      );
      emailErr.stage = 'identity';
      throw emailErr;
    }

    var payload = Payload.portalInvite({
      correlationId: recoveredCorrelationId,
      userEmail:     userEmail,
      role:          'analyst',
      spreadsheetId: ss.getId()
    });

    Stage.run('webhook', function() {
      return Webhook.call(config.webhook.portalInviteUrl, payload);
    });

    log('INFO', 'Portal invite sent for: ' + userEmail);

    return Result.ok({
      flow:          'portalInvite',
      correlationId: recoveredCorrelationId,
      message:       'Portal access request sent for:\n' + userEmail,
      data: {
        userEmail: userEmail
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Portal invite failed at ' + stage + ': ' + e.message);

    // Result.correlationId reflects what's truthful: the recovered ID
    // when we have one, or the tracing ID when we don't. The caller can
    // still look up THIS run's log lines via the tracing ID even when
    // there's no upstream provision to correlate to. This is the
    // structural fix for the previous behavior, which surfaced a fresh
    // UUID on failure that pointed to nothing in Workato.
    return Result.fail({
      flow:          'portalInvite',
      correlationId: recoveredCorrelationId || traceCorrelationId,
      message:       'Portal invite failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------
/**
 * Ad-hoc preflight for the portal-invite flow. Lighter than Preflight.run
 * because we are not serializing config or sharing files - we just need
 * the portal-invite webhook URL configured.
 *
 * Throws on first failure with a stage-tagged Error.
 */
Portal._preflight = function(config) {
  if (!config.webhook.portalInviteUrl) {
    var err = new Error(
      'Portal invite URL not configured. ' +
      'Check _developer_settings -> webhook.portalInviteUrl.'
    );
    err.stage = 'preflight';
    throw err;
  }
};

// Stage handling is now in Stage.gs (Stage.run). Portal no longer
// has a private _stage helper.