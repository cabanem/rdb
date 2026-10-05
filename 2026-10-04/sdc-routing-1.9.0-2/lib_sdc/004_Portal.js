/**
 * @file 004_Portal.gs
 * Portal-invite orchestrator - the "Request portal access" flow.
 *
 * Slim by design. Does not serialize config or touch Drive.
 *
 * Pipeline:
 *   Config.build -> Payload.portalInvite -> Webhook.call (router, path /portal-invite)
 *
 * Correlation ID handling (1.9.0):
 *   The invite gets its own correlation ID. Before routing, the flow recovered the originating provision's ID
 *   from _script_logs so the invite could be tied to a provision; the router now ties the call to the workspace
 *   by spreadsheet_id, and a workbook that has never provisioned is rejected by the router (NOT_PROVISIONED)
 *   rather than by a log lookup. The _script_logs dependency is gone.
 *
 * Public:
 *   Portal.run(ss) -> Result
 */

var Portal = {};

Portal.run = function(ss) {
  if (!ss) throw new Error('Portal.run: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  log('INFO', 'Starting portal invite...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    var userEmail = Util.getActiveUserEmail('');
    if (!userEmail) {
      var emailErr = new Error(
        'Could not resolve your email address. Ensure you are signed in with a Google account.'
      );
      emailErr.stage = 'identity';
      throw emailErr;
    }

    var payload = Payload.portalInvite({
      correlationId: correlationId,
      userEmail:     userEmail,
      role:          'analyst',
      spreadsheetId: ss.getId()
    });

    Stage.run('endpoint', function() {
      return Webhook.call(config,
        { path: '/portal-invite', spreadsheetId: ss.getId(), correlationId: correlationId },
        payload);
    });

    log('INFO', 'Portal invite sent for: ' + userEmail);

    return Result.ok({
      flow:          'portalInvite',
      correlationId: correlationId,
      message:       'Portal access request sent for:\n' + userEmail,
      data: {
        userEmail: userEmail
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Portal invite failed at ' + stage + ': ' + e.message);

    return Result.fail({
      flow:          'portalInvite',
      correlationId: correlationId,
      message:       'Portal invite failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};
