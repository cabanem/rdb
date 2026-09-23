/**
 * @file 005_Provision.gs
 * Provision orchestrator - the "Start supplier data collection" flow.
 *
 * Pipeline:
 *   Config.build -> Preflight.run -> PrimaryKey.backfill ->
 *   Drive.serializeConfig('provision') -> Variant.serializeAll ->
 *   Drive.shareWithIntegrationAccount(base) -> Drive.shareWithEditors ->
 *   Payload.provision -> Webhook.call
 *
 * Returns a canonical Result; container handles UI. correlationId is generated up-front so every log line and
 * the eventual webhook payload share one tracing ID, even if the flow fails mid-pipeline.
 *
 * Public:
 *   Provision.run(ss) -> Result
 */

var Provision = {};

/**
 * Run the provision flow end-to-end.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      options
 * @param {boolean}     options.isInitial - True for initial provision runs; false for update runs. Menu-derived
 *                                          ("Start supplier data collection" vs "Update configuration"). Required;
 *                                          no default to force the caller to be explicit about intent.
 * @returns {Object} canonical Result
 */
Provision.run = function (ss, options) {
  if (!ss) throw new Error('Provision.run: ss is required.');
  if (!options || typeof options.isInitial !== 'boolean') {
    throw new Error(
      'Provision.run: options.isInitial is required and must be boolean. ' +
      'Pass { isInitial: true } for first-time provisioning or ' +
      '{ isInitial: false } for updates.'
    );
  }
  var isInitial = options.isInitial;

  var correlationId = Util.newCorrelationId();
  var log = Log.forCorrelation(ss, correlationId);

  // Config.build only asserts on MAJOR schema version; an unmigrated minor (e.g. 1.2 workbook vs 1.3 library) would
  // pass config and fail confusingly at preflight ("Customer name missing" while the analyst can see it, under
  // the old label text). Fail early with the real reason instead.
  if (Migrations.isMigrationNeeded(ss)) {
    var schemaErr = new Error(
      'Workbook schema is outdated for this library version. Run "Migrate workbook schema" from the menu, then retry.'
    );
    schemaErr.stage = 'schema-outdated';
    log('ERROR', 'Provision blocked: workbook schema outdated.');
    return Result.fail({
      flow: 'provision', correlationId: correlationId,
      message: 'Provision failed at schema-outdated:\n\n' + schemaErr.message,
      error: schemaErr
    });
  }

  log('INFO', 'Starting provision (' + (isInitial ? 'initial' : 'update') + ')...');

  try {
    // 1. Build config (also runs schema compatibility check).
    var config = Stage.run('config', function () {
      return Config.build(ss);
    });

    // 2. Preflight - connector sheets, customer data, integration account.
    var pf = Stage.run('preflight', function () {
      return Preflight.run(ss, config, {
        webhookUrl: config.webhook.url,
        webhookLabel: 'provisionUrl',
        requireCustomerData: true
      });
    });

    // 3. Stamp PKs in any new rows.
    var pkResult = Stage.run('primary-key-backfill', function () {
      return PrimaryKey.backfill(ss);
    });
    if (pkResult.totalStamped > 0) {
      log('INFO', 'Stamped ' + pkResult.totalStamped + ' new field IDs across ' +
        Object.keys(pkResult.stamped).filter(function (k) {
          return pkResult.stamped[k] > 0;
        }).join(', ') + '.');
    }

    // 4. Serialize base config to Drive.
    var baseResult = Stage.run('serialize', function () {
      return Drive.serializeConfig(ss, config, { purpose: 'provision' });
    });
    var configJsonFileId = baseResult.fileId;
    var configFingerprint = baseResult.baseOutput._meta.config_fingerprint;
    log('INFO', 'Config serialized to Drive. File ID: ' + configJsonFileId);
    log('INFO', 'Config fingerprint: ' + configFingerprint);

    // 4b. Serialize variant configs to Drive (one JSON per variant).
    //     Reuses baseResult.baseOutput so connector sheets are read exactly once across base + variants.
    var variantResult = Stage.run('serialize-variants', function () {
      return Variant.serializeAll(ss, config, {
        purpose: 'provision',
        integrationAccountEmail: pf.integrationAccountEmail,
        baseOutput: baseResult.baseOutput
      });
    });
    if (variantResult.variantsGenerated > 0) {
      log('INFO', 'Generated ' + variantResult.variantsGenerated + ' variant template(s): ' +
        variantResult.names.join(', ') + '.');
    }

    // 5. Share base file with Workato OAuth account (FATAL on failure).
    Stage.run('share-with-workato', function () {
      Drive.shareWithIntegrationAccount(configJsonFileId, pf.integrationAccountEmail);
    });

    // 6. Share base with audit/visibility editors (NON-FATAL).
    var shareResult = Drive.shareWithEditors(configJsonFileId, config.sharing.authorizedEditors);
    if (shareResult.failed.length > 0) {
      log('WARNING', 'Audit-share failures: ' + shareResult.failed.map(function (f) {
        return f.email + ' (' + f.error + ')';
      }).join('; '));
    }

    // 6b. Seed data: the analyst declared incumbent data, so Preflight has already guaranteed driveId + sheetName are present.
    //     Copy the named sheet to a standalone XLSX, share it with Workato, and carry the new file ID on the provision payload.
    var seedDataFileId = '';
    if (Util.coerceTruthy(pf.hasSeedData)) {
      var seed = Stage.run('seed-data-export', function () {
        return Drive.copySheetToXlsx(
          String(pf.seedDataDriveId).trim(),
          String(pf.seedDataSheetName).trim(),
          {
            destinationFolder: Drive.resolveDestinationFolder(ss, config, { purpose: 'provision' }),
            fileName: 'seed_' + ss.getId()
          }
        );
      });
      seedDataFileId = seed.fileId;

      Stage.run('share-seed-with-workato', function () {
        Drive.shareWithIntegrationAccount(seedDataFileId, pf.integrationAccountEmail);
      });

      log('INFO', 'Seed sheet "' + pf.seedDataSheetName +
        '" exported to XLSX. File ID: ' + seedDataFileId);
    }

    // 7. Build payload + fire webhook.
    var payload = Payload.provision({
      correlationId: correlationId,
      clientName: pf.clientName,
      analystEmail: pf.analystEmail,
      expectedDate: pf.expectedDate,
      lastDayForSubmission: pf.lastDayForSubmission,
      targetVms: pf.targetVms,
      applicationName: pf.applicationName,
      configFileId: ss.getId(),
      configJsonFileId: configJsonFileId,
      configFingerprint: configFingerprint,
      templateFileIds: variantResult.fileIds,
      isInitial: isInitial,
      outputDriveFolderId: pf.outputDriveFolderId,
      reminderDays: pf.reminderDays,
      supplierInstructions: pf.supplierInstructions,
      kickoffEmailBody: pf.kickoffEmailBody,
      hasSeedData: pf.hasSeedData,
      seedDataDriveId: pf.seedDataDriveId,
      seedDataSheetName: pf.seedDataSheetName,
      seedDataIndexKey: pf.seedDataIndexKey,
      seedDataHeaderRow: pf.seedDataHeaderRow,
      seedDataFirstDataRow: pf.seedDataFirstDataRow,
      seedDataXlsxFileId: seedDataFileId,
      spreadsheetId: ss.getId()
    });

    if (!config.webhook.apiPlatformToken) {
      var tokenErr = new Error(
        'API-Platform token not configured. ' +
        'Check _developer_settings -> webhook.apiPlatformToken.'
      );
      tokenErr.stage = 'endpoint';
      throw tokenErr;
    }

    var response = Stage.run('endpoint', function () {
      return Webhook.call(config.webhook.provisionUrl, payload, {
        apiToken: config.webhook.apiPlatformToken,
        fetchTimeoutSeconds: 250,
        maxAttempts: 1
      });
    });

    log('INFO', 'Provision endpoint returned HTTP ' + response.statusCode);

    if (response.parsed && response.parsed.ok === false) {
      var rejErr = new Error(
        response.parsed.error || 'Provision endpoint rejected the request.'
      );
      rejErr.stage = 'endpoint-rejected';
      throw rejErr;
    }

    log('SUCCESS', 'Provision complete.');

    // Resolve verdict + form channel ONCE through the shared resolver, so the sheet, the modal, and Result.data agree.
    // On the provision wire the verdict is validate_summary and the form-channel block rides at the top level of the response
    // envelope; resolve() handles both locations.
    var reportWarnings = [];
    var resolved = ValidationReport.resolve(response.parsed);
    var verdict = resolved.verdict;
    var formChannel = resolved.formChannel;
    var report = ValidationReport.write(ss, response.parsed, correlationId);
    if (report.ok) {
      log('INFO', 'Wrote ' + report.rowsWritten + ' finding(s) to _validation_results.');
    } else {
      reportWarnings.push('Could not write results to _validation_results (' +
        report.reason + '): ' + report.detail);
      log('WARNING', 'ValidationReport.write did not complete (' +
        report.reason + '): ' + report.detail);
    }

    // Build the success Result. Audit-share failures become structured warnings on Result.warnings
    // instead of being prose-appended to the message, so the container can render them consistently.
    var warnings = shareResult.failed.map(function (f) {
      return 'Audit-share failed for ' + f.email + ': ' + f.error;
    });

    // A non-viable form channel does not block provisioning (the upload path is
    // unaffected), but the analyst must hear about it even if the container only
    // renders the plain success alert - so it is a Result warning, not just a
    // modal row.
    if (formChannel && formChannel.status !== 'viable') {
      warnings.push(FormChannel.describe(formChannel));
      log('WARNING', 'Form channel ' + formChannel.status + '.');
    } else if (formChannel) {
      log('INFO', 'Form channel viable.');
    }

    if (!report.ok) {
      warnings.push('Could not write results to _validation_results; see _script_logs.');
    }

    return Result.ok({
      flow: 'provision',
      correlationId: correlationId,
      message: 'Configuration sent to Workato.',
      warnings: warnings,
      data: {
        configJsonFileId: configJsonFileId,
        templateFileIds: variantResult.fileIds,
        variantsGenerated: variantResult.variantsGenerated,
        variantNames: variantResult.names,
        stampedRows: pkResult.totalStamped,
        auditShareGranted: shareResult.granted.length,
        auditShareFailed: shareResult.failed.length,
        applicationName: pf.applicationName,
        validationResult: verdict,
        formChannel: formChannel,
        resultsWritten: report.rowsWritten
      }
    });
  } catch (e) {
    var stage = e.stage || 'unknown';
    log('ERROR', 'Provision failed at ' + stage + ': ' + e.message);
    return Result.fail({
      flow: 'provision',
      correlationId: correlationId,
      message: 'Provision failed at ' + stage + ':\n\n' + e.message,
      error: e
    });
  }
};

// --- Private helpers -------------------------------------------------
//
// Stage handling is now in Stage.gs (Stage.run). Provision no longer
// has a private _stage helper.
