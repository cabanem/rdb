/**
 * @file tests/WorkatoTests.gs — integration tests for the Auth-Token push.
 *
 * These hit the REAL endpoint. Run by hand via runWorkatoTests(); they are NOT
 * part of runTests(), which stays hermetic. The negative cases are rejected
 * before the Salesforce step — the token cases by Workato's gate, the
 * validation case by the recipe — so they're side-effect-free. The happy path
 * and the replay DO upsert a Salesforce record (correlation_id "TEST-<ms>"):
 * point Script Property WORKATO_TEST_URL at a test recipe or sandbox, or clean
 * the record up afterwards.
 *
 * Retired with HMAC: dryRunSignature, flipLastChar_, and the signature /
 * timestamp-skew scenarios. Replaced by bad-token and missing-token cases.
 */

/** Set false to skip the two scenarios that reach Salesforce. */
const RUN_SF_PATH = true;

/** Expected status codes — align to your recipe's response mapping. */
const WT = { OK: 200, UNAUTHORIZED: 401, BAD_REQUEST: 400 };

/**
 * One-shot sanity check: send the token and report what the endpoint says.
 * Reading the result (Workato's gate runs before the recipe):
 *   200 -> token accepted and the recipe ran through.
 *   400 -> token accepted; the recipe's own validation rejected the body.
 *   401 -> token rejected: wrong value, or the access profile isn't attached.
 * @return {{code:number, body:string}}
 */
function probeApiToken() {
  const corr = 'TEST-PROBE-' + Date.now();
  const r = sendToWorkato_(workatoTestUrl_(), testPayload_(corr), workatoHeaders_(corr));
  Logger.log(WORKATO_TOKEN_HEADER + ' probe -> ' + r.code + '\n' + r.body.slice(0, 300));
  return r;
}

/**
 * Run the scenario set against the live endpoint and log a report.
 * @return {string} Summary line.
 */
function runWorkatoTests() {
  const url = workatoTestUrl_();
  const token = workatoSecret_();
  const corr = 'TEST-' + Date.now();
  const base = testPayload_(corr);

  const hdr = function (tok, c) {
    const h = { 'X-Correlation-Id': c };
    if (tok !== null) h[WORKATO_TOKEN_HEADER] = tok;
    return h;
  };
  const noCorr = JSON.parse(JSON.stringify(base)); delete noCorr.correlation_id;
  const badOpp = JSON.parse(JSON.stringify(base)); badOpp.fields.opportunity = 'Linker Finance';

  // [name, expected code, payload, headers, touchesSalesforce]
  const scenarios = [
    ['happy path (creates record)', WT.OK, base, hdr(token, corr), true],
    ['bad token', WT.UNAUTHORIZED, base, hdr(token + 'x', corr), false],
    ['missing api-token header', WT.UNAUTHORIZED, base, hdr(null, corr), false],
    ['missing correlation_id in body', WT.BAD_REQUEST, noCorr, hdr(token, corr), false],
    ['malformed opportunity (guard A)', WT.BAD_REQUEST, badOpp, hdr(token, corr), false],
    ['replay same request (upsert=update)', WT.OK, base, hdr(token, corr), true]
  ];

  let pass = 0, fail = 0, skip = 0;
  const lines = [];
  scenarios.forEach(function (s) {
    const name = s[0], expect = s[1], payload = s[2], headers = s[3], touchesSf = s[4];
    if (touchesSf && !RUN_SF_PATH) { skip++; lines.push('SKIP  ' + name + ' (RUN_SF_PATH=false)'); return; }
    try {
      const r = sendToWorkato_(url, payload, headers);
      const ok = (r.code === expect);
      if (ok) pass++; else fail++;
      lines.push((ok ? 'ok    ' : 'FAIL  ') + name + ' -> ' + r.code +
        (ok ? '' : ' (expected ' + expect + ')') + '  ' + r.body.slice(0, 120));
    } catch (e) {
      fail++; lines.push('FAIL  ' + name + ' -> transport error: ' + e.message);
    }
  });
  const summary = pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped  [corr ' + corr + ']';
  Logger.log(lines.join('\n') + '\n\n' + summary);
  return summary;
}

/**
 * Endpoint under test: Script Property WORKATO_TEST_URL if set (a test recipe),
 * else the production workato_webhook_url from Config.
 * @return {string}
 * @private
 */
function workatoTestUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WORKATO_TEST_URL') ||
    readConfig_().workato_webhook_url;
}

/**
 * A realistic payload matching the input schema (the Northwind fixture).
 * @param {string} corr correlation_id to embed.
 * @return {Object}
 * @private
 */
function testPayload_(corr) {
  const fields = {
    opportunity: 'REPLACE_WITH_TEST_OPPORTUNITY_ID',   // 006… on the agreed test account; guard A rejects this placeholder with 400
    'Agreement Type': 'Master Services Agreement',
    'Effective Date': '2026-01-15',
    'Client Name': 'Northwind Staffing Solutions, LLC',
    'Supplier Name': 'Cardinal Talent Partners, Inc.',
    'Total Contract Value': '248500.00',
    'Payment Terms': 'Net 45 days',
    'Auto-Renewal': 'Yes',
    'Governing Law': 'State of North Carolina',
    'Scope of Services': 'Contingent staffing and supplier-management services.'
  };
  const extracted = Object.assign({}, fields, {
    'Effective Date': 'the 15th day of January, 2026',
    'Total Contract Value': '$248,500.00'
  });
  return {
    correlation_id: corr,
    source: {
      file_id: 'TEST_FILE_ID', file_name: 'Test_Contract_MSA.pdf',
      drive_url: 'https://drive.google.com/file/d/TEST_FILE_ID/view'
    },
    extracted_at: new Date().toISOString(),
    model: 'gemini-2.5-pro',
    fields: fields,
    provenance: { extracted: extracted }
  };
}
