/**
 * Schema.gs tests. Paste into Tests.gs and add `registerSchemaTests_(t);` to runTests().
 * Covers the pure layer only: interpretSchemaResponse_, schemaRows_, reconcileSchema_, schemaFromRows_,
 * schemaFor_, isPicklist_. refreshSchema/fetchSchema_/writeSchemaTab_/loadSchema_ touch the network or the sheet
 * and are exercised by running refreshSchema() from the menu.
 */
function registerSchemaTests_(t) {
  var sample = [
    { name: 'Type_of_Contract__c', label: 'Type of Contract', type: 'picklist', length: 255, scale: 0, precision: 0,
      controller: null, values: [{ value: 'MSA', label: 'Master Services Agreement', valid_for: [] },
                                 { value: 'SOW', label: 'Statement of Work', valid_for: [] }] },
    { name: 'Product_Line_s__c', label: 'Product Line(s)', type: 'multipicklist', length: 4099, scale: 0, precision: 4,
      controller: null, values: [{ value: 'RPO', label: 'RPO', valid_for: [] }] },
    { name: 'Late_Charge__c', label: 'Late Charge', type: 'percent', length: 0, scale: 1, precision: 2, controller: null, values: null },
    { name: 'Name', label: 'Contract Name', type: 'string', length: 80, scale: 0, precision: 0, controller: null, values: null },
    { name: 'Countries_Supplying_Services__c', label: 'Countries Supplying Services', type: 'multipicklist', length: 4099,
      scale: 0, precision: 5, controller: 'Geographical_Scope__c',
      values: [{ value: 'Canada', label: 'Canada', valid_for: ['North America'] }] }
  ];

  // --- interpretSchemaResponse_ ---
  t('schema: 200 with fields returns the array', function () {
    assertEq_(interpretSchemaResponse_(200, { ok: true, fields: sample }).length, 5);
  });
  t('schema: non-200 throws with the message', function () {
    assertThrows_(function () { interpretSchemaResponse_(400, { ok: false, message: 'Nothing returned' }); }, 'Nothing returned');
  });
  t('schema: ok:false throws even on 200', function () {
    assertThrows_(function () { interpretSchemaResponse_(200, { ok: false, message: 'nope' }); }, 'nope');
  });
  t('schema: empty fields throws (never overwrite with nothing)', function () {
    assertThrows_(function () { interpretSchemaResponse_(200, { ok: true, fields: [] }); }, 'no fields');
  });

  // --- schemaRows_ ---
  t('schemaRows_: key is toSnake_(label), parentheses included', function () {
    var r = schemaRows_(sample);
    assertEq_(r.rows.map(function (x) { return x[0]; }),
      ['type_of_contract', 'product_line_s', 'late_charge', 'contract_name', 'countries_supplying_services']);
    assertEq_(r.collisions, []);
  });
  t('schemaRows_: non-picklist has blank Values; picklist has JSON', function () {
    var r = schemaRows_(sample);
    assertEq_(r.rows[2][8], '');
    assertEq_(JSON.parse(r.rows[0][8])[1].value, 'SOW');
  });
  t('schemaRows_: numeric columns are numbers, controller is a string', function () {
    var r = schemaRows_(sample);
    assertEq_(r.rows[2].slice(4, 7), [0, 1, 2]);
    assertEq_(r.rows[4][7], 'Geographical_Scope__c');
    assertEq_(r.rows[0][7], '');
  });
  t('schemaRows_: duplicate key keeps first and reports the collision', function () {
    var r = schemaRows_([
      { name: 'A__c', label: 'Payment Terms', type: 'string' },
      { name: 'B__c', label: 'Payment terms', type: 'string' }
    ]);
    assertEq_(r.rows.length, 1);
    assertEq_(r.rows[0][1], 'A__c');
    assert_(r.collisions[0].indexOf('payment_terms') === 0, 'collision names the key');
  });
  t('schemaRows_: fields without name or label are skipped', function () {
    assertEq_(schemaRows_([{ name: 'X__c' }, { label: 'Y' }, null]).rows.length, 0);
  });

  // --- reconcileSchema_ ---
  t('reconcileSchema_: both directions', function () {
    var rec = reconcileSchema_(['type_of_contract', 'late_charge'], ['Type of contract', 'Governing law']);
    assertEq_(rec.unmatchedConfig, ['Governing law']);
    assertEq_(rec.unmatchedSf, ['late_charge']);
  });

  // --- schemaFromRows_ round trip ---
  t('schemaFromRows_: round-trips schemaRows_ through a fake tab', function () {
    var rows = schemaRows_(sample).rows;
    var tab = [
      ['Fetched at', '2026-10-15T12:00:00.000Z'], ['Config labels not in Salesforce', ''],
      ['Salesforce fields not in Config', ''], ['', ''], SCHEMA_HEADERS
    ].concat(rows);
    var s = schemaFromRows_(tab);
    assertEq_(Object.keys(s).length, 5);
    assertEq_(s.type_of_contract.values[0].label, 'Master Services Agreement');
    assertEq_(s.late_charge.values, null);
    assertEq_(s.late_charge.scale, 1);
    assertEq_(s.countries_supplying_services.controller, 'Geographical_Scope__c');
    assertEq_(s.countries_supplying_services.values[0].valid_for, ['North America']);
  });
  t('schemaFromRows_: no header row -> {}', function () {
    assertEq_(schemaFromRows_([['Fetched at', 'x'], ['', '']]), {});
  });
  t('schemaFromRows_: bad Values JSON -> empty list, not a throw', function () {
    var s = schemaFromRows_([SCHEMA_HEADERS, ['k', 'K__c', 'K', 'picklist', 0, 0, 0, '', '{not json']]);
    assertEq_(s.k.values, []);
  });

  // --- lookup ---
  t('schemaFor_/isPicklist_: joins on the Config label, any case', function () {
    var s = schemaFromRows_([SCHEMA_HEADERS].concat(schemaRows_(sample).rows));
    assert_(schemaFor_(s, 'Type of contract') !== null, 'case-insensitive join');
    assertEq_(schemaFor_(s, 'Not a field'), null);
    assert_(isPicklist_(schemaFor_(s, 'Type of contract')), 'picklist');
    assert_(!isPicklist_(schemaFor_(s, 'Late charge')), 'percent is not a picklist');
    assert_(!isPicklist_(null), 'null-safe');
  });
}
