/**
 * @file 007_Validate.gs
 * Validate orchestrator - the "Validate configuration" flow.
 *
 * Pipeline (mirrors provision through serialization, then diverges):
 *   Config.build - Preflight.run(requireCustomerData: false)
 *   PrimaryKey.backfill Drive.serializeConfig('validate') ->
 *   Variant.serializeAll('validate') -> Drive.shareWithIntegrationAccount ->
 *   Validate._call (GET, API-TOKEN header; returns parsed validation result)
 *
 * Differs from provision in three ways:
 *   1. Customer-data preflight is skipped (validation does not require a complete 1_customer; it can sanity-check a partial config).
 *   2. Audit-share to authorizedEditors is skipped (validate files are transient debug artifacts, not the production source of truth).
 *   3. The webhook returns a parsed JSON body which is surfaced via Result.data so the container can render it in the modal dialog.
 *
 * Note: this flow stamps PKs into the workbook (PrimaryKey.backfill writes to the sheet). That mutation is documented
 * in the success message so users running validate know any unstamped IDs were filled in as part of the check.
 *
 * Public:
 *   Validate.run(ss) - Result
 */

var Validate = {};

Validate.run = function(ss) {
  if (!ss) throw new Error('Validate.run: ss is required.');

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  log('INFO', 'Starting validation...');

  try {
    var config = Stage.run('config', function() {
      return Config.build(ss);
    });

    var pf = Stage.run('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.validateUrl,
        webhookLabel:        'validateUrl',
        requireCustomerData: false
      });
    });

    var pkResult = Stage.run('primary-key-backfill', function() {
      return PrimaryKey.backfill(ss);
    });
    if (pkResult.totalStamped > 0) {
      log('INFO', 'Stamped ' + pkResult.totalStamped + ' new field IDs across ' +
                  Object.keys(pkResult.stamped).filter(function(k) {
                    return pkResult.stamped[k] > 0;
                  }).join(', ') + '.');
    }

    var baseResult = Stage.run('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'validate' });
    });
    var configJsonFileId = baseResult.fileId;
    log('INFO', 'Validate config serialized. File ID: ' + configJsonFileId);

    var variantResult = Stage.run('serialize-variants', function() {
      return Variant.serializeAll(ss, config, {
        purpose:                 'validate',
        integrationAccountEmail: pf.integrationAccountEmail,
        baseOutput:              baseResult.baseOutput
      });
    });
    if (variantResult.variantsGenerated > 0) {
      log('INFO', 'Generated ' + variantResult.variantsGenerated +
                  ' variant template(s) for validation.');
    }

    Stage.run('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // Note: shareWithEditors deliberately skipped - validate files are
    // transient and don't need audit-share distribution.

    // GET the endpoint with API-TOKEN header. Mirrors Preview.run.
    var response = Stage.run('endpoint', function() {
      return Validate._call(config.webhook.validateUrl, config.webhook.apiPlatformToken, {
        correlation_id:      correlationId,
        config_json_file_id: configJsonFileId,
        requester_email:     Util.getActiveUserEmail() || 'unavailable',
        timestamp:           new Date().toISOString(),
        payload_version:     String(SDC_PAYLOAD_VERSION),
        spreadsheet_id:      ss.getId()
      });
    });

    log('INFO', 'Validate endpoint returned HTTP ' + response.statusCode);

    if (!response.parsed) {
      var err = new Error('Validate endpoint returned a non-JSON body: ' +
                          String(response.body || '').substring(0, 1000));
      err.stage = 'endpoint-response';
      throw err;
    }

    // Resolve the verdict AND the form-channel block ONCE, through the same function the in-sheet writer uses, so the modal (showValidationResults_),
    // _validation_results, and Result.data read identical objects. The resolved verdict already carries form-channel viability as a synthetic check
    // (form_channel_viability), so the existing modal renders it with no container changes. verdict may be null when no recognizable verdict or
    // form-channel block is found; the container's `if (r.data.validationResult)` guard then falls back to the plain success alert.
    var resolved    = ValidationReport.resolve(response.parsed);
    var verdict     = resolved.verdict;
    var formChannel = resolved.formChannel;

    if (formChannel) {
      log('INFO', 'Form channel: ' + formChannel.status + '.');
    }

    // Persist the verdict in-sheet so findings live in the workbook, not just the modal.
    // A write failure must not fail a validation that already succeeded (surface it as a Result warning instead)
    var reportWarnings  = [];
    var report          = ValidationReport.write(ss, response.parsed, correlationId);
    if (report.ok) {
      log('INFO', 'Wrote ' + report.rowsWritten + ' finding(s) to ' + '_validation_results.');
    } else {
      reportWarnings.push('Could not write results to _validation_results (' +
        report.reason + '): ' + report.detail);
      log('WARNING', 'ValidationReport.write did not complete (' +
        report.reason + '): ' + report.detail);
    }

    // Unhide and activate the validation sheet.
    if (report.ok && report.rowsWritten > 0) {
      ValidationReport.activate(ss);
    }

    log('SUCCESS', 'Validation complete. Returned: ' + JSON.stringify(response.parsed).substring(0, 200));

    // Build the success message. PK-stamping and variant-generation notes were previously appended. Keep them here
    // because they're narrative side-effects of validation, not warnings about a problem.
    var notes = [];
    if (pkResult.totalStamped > 0) {
      notes.push(pkResult.totalStamped +
                 ' unstamped field ID(s) were filled in as part of this check.');
    }
    if (variantResult.variantsGenerated > 0) {
      notes.push(variantResult.variantsGenerated +
                 ' variant template(s) were generated.');
    }
    var noteBlock = notes.length ? '\n\nNote: ' + notes.join(' ') : '';

    return Result.ok({
      flow:          'validate',
      correlationId: correlationId,
      message:       'Validation complete.' + noteBlock,
      warnings:       reportWarnings,
      data: {
        configJsonFileId:  configJsonFileId,
        templateFileIds:   variantResult.fileIds,
        variantsGenerated: variantResult.variantsGenerated,
        stampedRows:       pkResult.totalStamped,
        validationResult:  verdict,
        formChannel:       formChannel,
        resultsWritten:    report.rowsWritten
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Validation failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow:          'validate',
      correlationId: correlationId,
      message:       'Validation failed at ' + stage + ':\n\n' + e.message,
      error:         e
    });
  }
};

// --- Private helpers -------------------------------------------------

/**
 * GET the validate endpoint with query params + API-TOKEN header. Mirrors Preview._call. Treats any 2xx as
 * success and returns the parsed body; lets 4xx/5xx through as parsed bodies too (the recipe signals an invalid
 * config in the body, not via status).
 */
Validate._call = function(url, apiToken, params) {
  if (!url)      throw new Error('Validate._call: validateUrl is empty.');
  if (!apiToken) throw new Error('Validate._call: apiPlatformToken is empty.');

  var qs = Object.keys(params).map(function(k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');

  var resp = UrlFetchApp.fetch(url + '?' + qs, {
    method:             'get',
    headers:            { 'API-TOKEN': apiToken },
    muteHttpExceptions: true
  });

  var body = resp.getContentText();
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) {}
  return { statusCode: resp.getResponseCode(), body: body, parsed: parsed };
};