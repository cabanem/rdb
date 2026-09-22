/**
 * Tests.gs — hermetic tests for the extractors and the AI-output validator.
 * Run from the editor (dpRunTests) or from Node (node run-tests-node.js). No Sheets access needed.
 *
 * Each case: [field name, current data type (or { type, required }), description, expected proposals...]
 * An expected proposal is [sheet, column, value] — value compared as a string, or as JSON for rules.
 * sheet may carry a confidence: 'rules:low', 'fields:lint' (a contradiction row; value null = any fix).
 * "none" as the only expectation means: nothing must be proposed.
 */

var DP_TEST_CTX = {
  fieldNames: ['Worker status', 'Contract type', 'Rate type', 'Employment type', 'Start date', 'Country of work', 'Hourly rate', 'Nationality',
               'pay_type', 'vendor_company_name', 'org_code'],
  fieldsByName: { 'Worker status': { lookup: 'active_or_leaver' }, 'Rate type': { lookup: 'rate_type' } },
  lookupTables: {
    yes_no:           { values: ['No', 'Yes'], codes: ['No', 'Yes'] },
    active_or_leaver: { values: ['Active', 'LEAVER'], codes: ['Active', 'LEAVER'] },
    currency_iso:     { values: ['EUR', 'GBP'], codes: ['EUR', 'GBP'] },
    rate_type:        { values: ['Daily', 'Hourly'], codes: ['Daily', 'Hourly'] },
    country_iso:      { values: ['Belgium', 'Germany'], codes: ['BE', 'DE'] },
    worker_level:     { values: ['Junior Assignment', 'Mid-level Assignment', 'Senior Assignment'], codes: ['Junior Assignment', 'Mid-level Assignment', 'Senior Assignment'] }
  },
  vocab: DP_VOCAB_DEFAULT
};

var DP_TEST_CASES = [
  ['Employment type', '', 'Employment type of the worker. Allowed values: Full-time, Part-time, Contractor.',
    ['fields', 'Data format', 'dropdown'], ['fields', 'Lookup name', 'employment_type'], ['lookups', 'table', 'employment_type']],
  ['Leaver', '', 'Indicate whether the worker is a leaver (Yes/No).',
    ['fields', 'Data format', 'dropdown'], ['fields', 'Lookup name', 'yes_no']],
  ['End date', '', 'End date of the assignment. Optional unless Worker status is leaver.',
    ['rules', 'Required if', { conditionField: 'Worker status', conditionValue: 'LEAVER' }], ['fields', 'Data type', 'date']],
  ['Hourly bill rate', '', 'Hourly bill rate in EUR. Maximum of 500.',
    ['fields', 'Numeric field validation', '<= 500'], ['fields', 'Data format', 'currency']],
  ['Email', '', "Worker's email address. Must be unique.",
    ['fields', 'Unique', 'true'], ['fields', 'Data format', 'email address']],
  ['PO number', 'string', 'Purchase order number, up to 20 characters.',
    ['fields', 'Field length validation', '<= 20']],
  ['Start date', '', 'Start date in the format DD/MM/YYYY. Cannot be in the future.',
    ['fields', 'Data format', 'date (dd/mm)'], ['fields', 'Data type', 'date'], ['fields', 'Date field validation', '<= TODAY']],
  ['NI number', '', 'National insurance number, exactly 9 characters, uppercase.',
    ['fields', 'Field length validation', 'exact: 9'], ['fields', 'Data cleaning flags', 'force_upper']],
  ['Allocation', '', 'Percentage of time allocated (0-100).',
    ['fields', 'Data format', 'percentage'], ['fields', 'Numeric field validation', '[0, 100]']],
  ['Hours per week', '', 'Number of hours per week. Must be a whole number between 1 and 60.',
    ['fields', 'Data type', 'integer'], ['fields', 'Numeric field validation', '[1, 60]']],
  ['Cost centre', '', 'Mandatory. The cost centre code, e.g. CC-1234.',
    ['fields', 'Required', 'true']],
  ['Country of work', '', 'Country of work as an ISO 2-letter code.',
    ['fields', 'Field input validation', '^[A-Z]{2}$'], ['fields', 'Lookup name', 'country_iso']],
  ['Phone', '', '10 digit phone number, numbers only.',
    ['fields', 'Field input validation', '^\\d{10}$']],
  ['Notes', '', 'Free text notes.', 'none'],
  ['Fixed term end', '', "Required if Contract type is 'Fixed term'.",
    ['rules', 'Required if', { conditionField: 'Contract type', conditionValue: 'Fixed term' }]],
  ['Day rate', '', 'Leave blank if Rate type is Daily.',
    ['rules', 'Must be empty if', { conditionField: 'Rate type', conditionValue: 'Daily' }]],
  ['Date of birth', '', 'Date of birth. Must be in the past.',
    ['fields', 'Date field validation', '< TODAY'], ['fields', 'Data type', 'date']],
  ['Currency', '', 'Currency in which the rate is paid (EUR or GBP).',
    ['fields', 'Lookup name', 'currency_iso']],
  ['Amount', 'float (2)', 'Amount must be greater than 0.',
    ['fields', 'Numeric field validation', '> 0']],
  ['Worker level', '', 'Worker level: one of Junior Assignment, Mid-level Assignment or Senior Assignment',
    ['fields', 'Lookup name', 'worker_level']],
  ['Age', 'integer', 'Age of the worker. Must be at least 18 and less than 70.',
    ['fields', 'Numeric field validation', '[18, 70)']],
  ['Client ref', '', 'Client reference between 5 and 10 characters, alphanumeric.',
    ['fields', 'Field length validation', '[5, 10]'], ['fields', 'Field input validation', '^[A-Za-z0-9]+$']],
  ['Contract start', 'date', 'Contract start date. Must be on or after 2024-01-01.',
    ['fields', 'Date field validation', '>= 2024-01-01']],
  ['Rate', '', 'Daily rate. Must not exceed 1,500.',
    ['fields', 'Numeric field validation', '<= 1500']],
  ['Colour', '', 'Enter one of the following values: red, green, blue.',
    ['lookups', 'table', 'colour']],
  ['Team', '', 'The team the worker sits in, e.g. Finance, HR or Sales.', 'none'],
  ['Passport', '', 'Required if Nationality is not blank.',
    ['rules:low', 'Required if', null]],
  ['Manager', '', 'Required when Employment type is Contractor and Country of work is Germany.',
    ['rules:low', 'Required if', null]],

  // ---- pasted VMS specs. The second element may be { type, required } to set the row's current cells.
  // VNDLY (labelled): bullets under "Values allowed:", "Data Type:", "Example:"
  ['Status', 'string', 'Required\n\nWork Order Status.\nValues allowed:\n● active\n● ended\n● ready to onboard\n● ignore\n\nData Type: Character\n\nExample: active',
    ['fields', 'Data format', 'dropdown'], ['lookups', 'table', 'status']],
  ['contractor_birth_mmdd', { type: 'date', required: true }, 'Required\n\nMonth and day of birth.\n\nData Type: Character (4)\n\nExample: 0214',
    ['fields:lint', 'Data type', 'string'], ['fields', 'Field length validation', 'exact: 4'], ['fields', 'Field input validation', '^\\d{4}$']],
  ['minimum_hours_to_qualify', { type: '', required: true }, "Optional/Required\n\n(Required if pay_type = 'daily')\n\nData Type: Integer\n\nExample: 6",
    ['fields', 'Data type', 'integer'], ['rules:high', 'Required if', { conditionField: 'pay_type', conditionValue: 'daily' }], ['fields:lint', 'Required', 'false']],
  ['primary_vendor_user', '', 'Required if "vendor_company_name" field is\nblank\n\nValid username.\n\nData Type: Character(255)\n\nExample: bob.smith@example.com',
    ['rules', 'At least one required', { conditionField: 'vendor_company_name', conditionValue: '' }], ['fields', 'Field length validation', '<= 255'], ['fields', 'Data format', 'email address']],
  ['Type', { type: 'string', required: true }, 'Optional\n\nType of Work Order.\nValues allowed:\n-contractor\n-direct hire\n-tracked worker\n\nData Type: Character\n\nExample: tracked worker\n\nDefault: contractor',
    ['fields:lint', 'Required', 'false'], ['lookups', 'table', 'type']],
  ['pay_type', { type: '', required: true }, 'Optional/Required\n(If your tenant is configured for pay groups, this is required)\n\nHow the contractor will be billed. Must be one of:\n- hourly\n- daily\n- weekly\n- monthly\n- milestone payments\nData Type: string\n\nExample: hourly',
    ['fields', 'Data type', 'string'], ['lookups', 'table', 'pay_type'], ['fields:lint', 'Required', 'false']],
  ['end_time', '', 'Optional\n\nUsed only if the Work Order should end at a specific time.\n\nData Type: Time (hh:mm)\n\nExample: 24:00',
    ['fields:lint', 'Data type', null]],
  ['end_date', '', 'Required\n\nContractor project end date (future). May not be before the Start Date.\nFormat: yyyy-mm-dd (ISO-8601)\n\nData Type: Datex\n\nExample: 2021-12-01',
    ['fields', 'Data type', 'date'], ['fields', 'Data format', 'date (YYYY-MM-DD)'], ['fields', 'Required', 'true']],
  ['budget_allocated', '', 'Optional\n\nBudget amount for projects on this contract.\n\nData Type: Integer\n\nExample: 1000.00',
    ['fields', 'Data type', 'float (2)']],
  ['job_site', '', 'Optional\n\nProject site related to job. Valid values: \n* Onsite\n* Remote',
    ['lookups', 'table', 'job_site']],
  // Fieldglass (positional): type / length / Yes-No as three lines, or on one line, then the description
  ['Cost Center Code', '', 'Text\n200\nYes\nValid SAP Fieldglass Cost Center Code\nWorker cost center code.',
    ['fields', 'Data type', 'string'], ['fields', 'Field length validation', '<= 200'], ['fields', 'Required', 'true']],
  ['Modification Type', '', 'Char 1 Yes\nValid values are:\n• A\n• D\nA = Add\nD = Delete',
    ['fields', 'Field length validation', '<= 1'], ['lookups', 'table', 'modification_type']],
  ['GL Account Code', '', 'Text\n100\nYes, if company configuration GLA allocation on job postings\nGL account code.',
    ['fields', 'Field length validation', '<= 100'], ['fields:lint', 'Required', null]],
  // no spec shape at all: unchanged behaviour
  ['Supplier comments', '', 'Please provide any notes or concerns for the record.', 'none']
];

function dpRunTests() {
  var out = [], failed = 0, passed = 0;
  var log = function (s) { out.push(s); };

  DP_TEST_CASES.forEach(function (c) {
    var ctx = {};
    Object.keys(DP_TEST_CTX).forEach(function (k) { ctx[k] = DP_TEST_CTX[k]; });
    ctx.fieldName = c[0]; ctx.dataFormat = ''; ctx.lookupName = '';
    if (c[1] && typeof c[1] === 'object') { ctx.dataType = c[1].type || ''; ctx.required = c[1].required === true; }
    else { ctx.dataType = c[1]; ctx.required = false; }                     // a blank Required cell
    var got = dpExtract(c[2], ctx);
    var expectations = c.slice(3);
    var problems = [];

    if (expectations[0] === 'none') {
      if (got.length) problems.push('expected nothing, got ' + got.map(dpTestFmt_).join(' ; '));
    } else {
      expectations.forEach(function (e) {
        var wantConf = e[0].split(':')[1], sheet = e[0].split(':')[0];
        var hit = got.filter(function (p) {
          if (p.sheet !== sheet || p.column !== e[1]) return false;
          if (wantConf && p.confidence !== wantConf) return false;
          if (e[2] === null) return true;
          return typeof e[2] === 'object' ? JSON.stringify(p.value) === JSON.stringify(e[2]) : String(p.value) === e[2];
        });
        if (!hit.length) problems.push('missing ' + e[0] + ' / ' + e[1] + ' = ' + (e[2] === null ? '(any)' : JSON.stringify(e[2])));
      });
    }
    if (problems.length) { failed++; log('FAIL  ' + c[0] + ' :: ' + c[2] + '\n      ' + problems.join('\n      ') + '\n      got: ' + got.map(dpTestFmt_).join(' ; ')); }
    else { passed++; log('ok    ' + c[0]); }
  });

  // AI-output validation: bad answers must be rejected, good ones kept
  var aiCtx = {};
  Object.keys(DP_TEST_CTX).forEach(function (k) { aiCtx[k] = DP_TEST_CTX[k]; });
  aiCtx.fieldName = 'Visa expiry'; aiCtx.dataType = ''; aiCtx.dataFormat = ''; aiCtx.lookupName = '';
  var aiItem = {
    id: '0',
    field_updates: [
      { column: 'Data type', value: 'Date', evidence: 'expiry' },                 // ok, casing fixed
      { column: 'Date field validation', value: 'after today', evidence: 'x' },   // rejected: not notation
      { column: 'Numeric field validation', value: '<= 10', evidence: 'x' },      // ok
      { column: 'Depends on', value: 'drop table', evidence: 'x' },               // rejected: not an identifier
      { column: 'Description', value: 'hello', evidence: 'x' }                    // rejected: not writable
    ],
    allowed_values: ['Yes', 'No'],
    complex_rules: [
      { rule: 'required if', condition_field: 'worker status', condition_value: 'Active', evidence: 'x' },   // ok, resolved
      { rule: 'Must equal', condition_field: 'Nobody', condition_value: '', evidence: 'x' }                  // rejected
    ]
  };
  var aiProps = dpAiToProposals_(aiItem, aiCtx);
  var aiProblems = [];
  var find = function (col, val) { return aiProps.filter(function (p) { return p.column === col && (val === undefined || String(p.value) === val); })[0]; };
  if (!find('Data type', 'date') || find('Data type', 'date').note) aiProblems.push('Data type "Date" should canonicalise to date');
  if (!/REJECTED/.test((find('Date field validation') || {}).note || '')) aiProblems.push('"after today" should be rejected');
  if ((find('Numeric field validation', '<= 10') || {}).note) aiProblems.push('"<= 10" should pass');
  if (!/REJECTED/.test((find('Depends on') || {}).note || '')) aiProblems.push('"drop table" should be rejected');
  if (!find('Lookup name', 'yes_no')) aiProblems.push('allowed_values Yes/No should map to yes_no');
  var rule = aiProps.filter(function (p) { return p.sheet === 'rules' && p.column === 'Required if'; })[0];
  if (!rule || rule.value.conditionField !== 'Worker status') aiProblems.push('rule should resolve to "Worker status"');
  var badRule = aiProps.filter(function (p) { return p.sheet === 'rules' && /REJECTED/.test(p.note); })[0];
  if (!badRule) aiProblems.push('"Must equal" should be rejected');
  if (aiProblems.length) { failed++; log('FAIL  ai-validation\n      ' + aiProblems.join('\n      ')); } else { passed++; log('ok    ai-validation'); }

  var summary = passed + ' passed, ' + failed + ' failed';
  log(summary);
  var text = out.join('\n');
  if (typeof Logger !== 'undefined') Logger.log(text);
  if (typeof SpreadsheetApp !== 'undefined') { try { SpreadsheetApp.getActiveSpreadsheet().toast(summary + ' (details in the execution log)', 'Extractor tests', 6); } catch (e) {} }
  return { passed: passed, failed: failed, text: text };
}

function dpTestFmt_(p) { return p.sheet + '/' + p.column + '=' + (typeof p.value === 'object' ? JSON.stringify(p.value) : p.value) + '[' + p.confidence + ']'; }
