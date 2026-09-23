var Preview = {};

/**
 * Build a preview of the supplier XLSX from the current workbook config via the
 * preview API-Platform endpoint (GET, API-TOKEN header). On a valid config the
 * returned base64 is written to _previews; on an invalid config the verdict is
 * returned in Validate's shape so the container reuses showValidationResults_.
 */
Preview.run = function(ss, opts) {
  if (!ss) throw new Error('Preview.run: ss is required.');
  opts = opts || {};

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);
  log('INFO', 'Starting template preview...');

  try {
    var config = Stage.run('config', function() { return Config.build(ss); });

    if (!config.webhook.previewUrl) {
      var e0 = new Error('webhook.previewUrl is not set in _developer_settings.');
      e0.stage = 'config'; throw e0;
    }

    var pf = Stage.run('preflight', function() {
      return Preflight.run(ss, config, {
        webhookUrl:          config.webhook.previewUrl,
        webhookLabel:        'previewUrl',
        requireCustomerData: false
      });
    });

    Stage.run('primary-key-backfill', function() { return PrimaryKey.backfill(ss); });

    var baseResult = Stage.run('serialize', function() {
      return Drive.serializeConfig(ss, config, { purpose: 'validate' });
    });
    var configJsonFileId = baseResult.fileId;

    log('INFO', 'Calling preview endpoint: ' + config.webhook.previewUrl);

    Stage.run('share-with-workato', function() {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // GET the endpoint. NOT Webhook.call (that POSTs JSON with no auth header).
    var response = Stage.run('endpoint', function() {
      return Preview._call(config.webhook.previewUrl, config.webhook.apiPlatformToken, {
        correlation_id:      correlationId,
        config_json_file_id: configJsonFileId,
        requester_email:     Util.getActiveUserEmail() || "unavailable",
        variant_id:          opts.variantId || '',
        timestamp:           new Date().toISOString(),
        payload_version:     String(SDC_PAYLOAD_VERSION),
        spreadsheet_id:      ss.getId()
      });
    });

    log('INFO', 'Endpoint returned HTTP ' + response.statusCode);
    var p = response.parsed;

    if (!p) {
      var e1 = new Error('Preview endpoint returned a non-JSON body: ' +
                         String(response.body || '').substring(0, 200));
      e1.stage = 'endpoint-response'; throw e1;
    }

    // ############## DEBUGGING START ####################################################################
    log('INFO', 'Preview raw: ok=' + p.ok + ' status=' + (p.verdict && p.verdict.status) + ' has_file=' + !!p.file_content + ' fields=' + JSON.stringify(Object.keys(p)));
    log('INFO', 'Preview raw: ' + JSON.stringify(p));
    log('INFO', 'Preview http: ' + response.statusCode);
    // ############## DEBUGGING END ######################################################################

    var verdict = p.verdict || {};

    // Genuinely invalid config: hand back the verdict in Validate's shape. No file.
    if (p.ok === false || verdict.status === 'invalid' || verdict.status === 'fail') {
      log('INFO', 'Preview: config not yet valid; returning verdict.');
      return Result.ok({
        flow: 'preview', correlationId: correlationId,
        message: 'Configuration is not yet valid to build.',
        data: { validationResult: verdict }
      });
    }

    // Config accepted, but no file came back. This is a BUILD error, not a validation problem.
    // Surface it as a failure so the container routes it to showResult_ instead of rendering a (passing) validation modal.
    if (!p.file_content) {
      var be = new Error(
        'Preview endpoint accepted the config but returned no file_content. ' +
        'This is a build error, not a validation problem. See _script_logs ' +
        'for the raw endpoint response.'
      );
      be.stage = 'build';
      throw be;
    }
    log('SUCCESS', 'Preview built: ' + (p.suggested_filename || 'preview.xlsx'));
    return Result.ok({
      flow:     'preview', correlationId: correlationId,
      message:  'Template preview built.',
      data: {
        fileContent:      p.file_content,
        fileName:         p.suggested_filename || 'preview.xlsx',
        validationResult: verdict,
        metadata:         p.metadata || {}
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Preview failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow: 'preview', correlationId: correlationId,
      message: 'Preview failed at ' + stage + ':\n\n' + e.message, error: e
    });
  }
};

/**
 * GET the preview endpoint with query params + API-TOKEN header. Mirrors the
 * proven test stub. Treats any 2xx as success and returns the parsed body; lets
 * 4xx/5xx through as parsed bodies too (the recipe signals invalid config in the
 * body, not via status — see note on the 400/200 recipe change).
 */
Preview._call = function(url, apiToken, params) {
  if (!url)      throw new Error('Preview._call: previewUrl is empty.');
  if (!apiToken) throw new Error('Preview._call: apiPlatformToken is empty.');

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