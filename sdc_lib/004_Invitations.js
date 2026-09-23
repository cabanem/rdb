/**
 * @file 004_Invitations.gs
 * Invitations orchestrator — the "Send invitations" flow.
 *
 * Pipeline:
 *   Config.build → Invitations._preflight →
 *   Payload.invitations → Webhook.call →
 *   Result with summary+results in data
 *
 * Returns a canonical Result; container handles UI. batch_id is generated
 * up-front so every log line and the eventual webhook payload share one
 * tracing ID, even if the flow fails mid-pipeline.
 *
 * Public:
 *   Invitations.run(ss, opts) → Result
 */

var Invitations = {};

/**
 * @param {Spreadsheet} ss
 * @param {Object}      opts
 * @param {Array<string>} opts.supplierRequestIds  - Required; non-empty array
 *                                                     of UUID strings, sourced
 *                                                     from the GAS menu selection
 *                                                     on _suppliers.
 * @returns {Object} canonical Result
 */
Invitations.run = function(ss, opts) {
  if (!ss) throw new Error('Invitations.run: ss is required.');
  if (!opts || !Array.isArray(opts.supplierRequestIds) || opts.supplierRequestIds.length === 0) {
    throw new Error('Invitations.run: opts.supplierRequestIds is required and must be a non-empty array.');
  }

  // Mint batch_id up-front so log lines and the payload share it,
  // even if the flow fails mid-pipeline. See Provision/Portal for the
  // same pattern (those use correlationId).
  var batchId = Util.newCorrelationId();   // UUID; reuse existing generator
  var log = Log.forCorrelation(ss, batchId);

  log('INFO', 'Starting invitations batch (batch_id: ' + batchId +
              ', count: ' + opts.supplierRequestIds.length + ')...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    Stage.run('preflight', function() {
      Invitations._preflight(config);
    });

    var analystEmail = Util.getActiveUserEmail('');
    if (!analystEmail) {
      var emailErr = new Error(
        'Could not resolve your email address. Ensure you are signed in with a Google account.'
      );
      emailErr.stage = 'identity';
      throw emailErr;
    }

    var payload = Payload.invitations({
      batchId:             batchId,
      supplierRequestIds:  opts.supplierRequestIds,
      analystEmail:        analystEmail
    });

    var webhookResponse = Stage.run('webhook', function() {
      return Webhook.call(config.webhook.invitationsUrl, payload);
    });

    // Parse the structured response. R1 returns:
    //   { ok, batch_id, started_at, completed_at, summary, results }
    var parsed = webhookResponse.parsed;
    if (!parsed) {
      var parseErr = new Error(
        'Invitations webhook returned a non-JSON body. ' +
        'Cannot render per-supplier results.'
      );
      parseErr.stage = 'response-parse';
      throw parseErr;
    }
    if (parsed.ok === false) {
      var rejErr = new Error(parsed.error || 'Invitations webhook rejected the batch.');
      rejErr.stage = 'webhook-rejected';
      throw rejErr;
    }

    var summary = parsed.summary || {};
    log('INFO',
      'Invitations batch complete: ' +
      (summary.invited || 0) + ' invited, ' +
      (summary.partial || 0) + ' partial, ' +
      (summary.already_invited || 0) + ' already invited, ' +
      (summary.skipped_no_primary || 0) + ' skipped (no primary), ' +
      (summary.assignee_failed || 0) + ' failed.'
    );

    return Result.ok({
      flow:          'invitations',
      correlationId: batchId,
      message:       Invitations._formatSummary(summary),
      data: {
        summary: summary,
        results: parsed.results || [],
        startedAt:   parsed.started_at,
        completedAt: parsed.completed_at
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Invitations failed at ' + stage + ': ' + e.message);

    return Result.fail({
      flow:          'invitations',
      correlationId: batchId,
      message:       'Invitations failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------

/**
 * Ad-hoc preflight for the invitations flow. Lighter than Preflight.run
 * because we are not serializing config or sharing files — we just need
 * the invitations webhook URL configured.
 *
 * Throws on first failure with a stage-tagged Error.
 */
Invitations._preflight = function(config) {
  if (!config.webhook.invitationsUrl) {
    var err = new Error(
      'Invitations URL not configured. ' +
      'Check _developer_settings → webhook.invitationsUrl.'
    );
    err.stage = 'preflight';
    throw err;
  }
};

/**
 * Compose the short message that goes in Result.message. The HTML modal
 * shows the full per-supplier breakdown; this is the one-sentence summary.
 */
Invitations._formatSummary = function(summary) {
  var parts = [];
  if (summary.invited)            parts.push(summary.invited + ' invited');
  if (summary.partial)            parts.push(summary.partial + ' with partial failures');
  if (summary.already_invited)    parts.push(summary.already_invited + ' already invited');
  if (summary.skipped_no_primary) parts.push(summary.skipped_no_primary + ' skipped (no primary)');
  if (summary.skipped_state)      parts.push(summary.skipped_state + ' skipped (state)');
  if (summary.assignee_failed)    parts.push(summary.assignee_failed + ' failed');
  if (summary.system_errored)     parts.push(summary.system_errored + ' errored');

  if (parts.length === 0) {
    return 'No invitations processed.';
  }
  return parts.join(', ') + '.';
};
