/**
 * @file 004_Invitations.gs
 * Invitations orchestrator — the "Send supplier invitations" flow.
 *
 * Pipeline:
 *   Config.build → Payload.invitations → Webhook.call (router, path /invitations) → Result
 *
 * Contract (R-1, POST /invitations on the client workspace):
 *   request   { batch_id, analyst_email, spreadsheet_id, exclude_supplier_request_ids, timestamp, payload_version }
 *   response  { ok, batch_id, started_at, completed_at, summary, results }
 *
 * The workspace decides who is invitable (every request in the invitable state for this workbook's project); the
 * workbook only says who to leave out. An empty exclude list is the common "send to all pending" case the menu
 * offers. A selection-based variant is the same call with the unselected IDs excluded.
 *
 * batch_id is generated up-front so every log line and the payload share one tracing ID.
 *
 * Public:
 *   Invitations.run(ss, [opts]) → Result
 */

var Invitations = {};

/**
 * @param {Spreadsheet}   ss
 * @param {Object}        [opts]
 * @param {Array<string>} [opts.excludeSupplierRequestIds=[]] - UUIDs to leave out of this batch.
 * @returns {Object} canonical Result
 */
Invitations.run = function(ss, opts) {
  if (!ss) throw new Error('Invitations.run: ss is required.');
  opts = opts || {};
  var excludeIds = Array.isArray(opts.excludeSupplierRequestIds) ? opts.excludeSupplierRequestIds : [];

  var batchId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, batchId);

  log('INFO', 'Starting invitations batch (batch_id: ' + batchId +
              (excludeIds.length ? ', excluding ' + excludeIds.length : ', all pending') + ')...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
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
      batchId:                   batchId,
      analystEmail:              analystEmail,
      spreadsheetId:             ss.getId(),
      excludeSupplierRequestIds: excludeIds
    });

    // A batch is not idempotent (it assigns tasks and sends email), so one attempt. R-1 can take a while for a
    // large roster; give UrlFetchApp the same budget provision gets.
    var response = Stage.run('endpoint', function() {
      return Webhook.call(config,
        { path: '/invitations', spreadsheetId: ss.getId(), correlationId: batchId },
        payload,
        { fetchTimeoutSeconds: 250, maxAttempts: 1 });
    });

    var parsed = response.parsed;
    if (!parsed) {
      var parseErr = new Error(
        'Invitations endpoint returned a non-JSON body. Cannot render per-supplier results.'
      );
      parseErr.stage = 'response-parse';
      throw parseErr;
    }
    if (parsed.ok === false) {
      var rejErr = new Error(parsed.error || 'Invitations endpoint rejected the batch.');
      rejErr.stage = 'endpoint-rejected';
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
        summary:     summary,
        results:     parsed.results || [],
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
 * Compose the short message that goes in Result.message. The HTML modal shows the full per-supplier breakdown;
 * this is the one-sentence summary.
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
