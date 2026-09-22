// Node tests for 011_Packs.js — the pure parts (plan, _locate, _readTable) with a fake sheet.
// Usage: node test/packs.test.js
var path = require('path'), fs = require('fs'), vm = require('vm');
var sandbox = { console: console, Math: Math, Date: Date, JSON: JSON, String: String, Object: Object, Array: Array, Error: Error,
  Util: { coerceTruthy: function(v) { return ['true','1','yes'].indexOf(String(v).trim().toLowerCase()) >= 0; } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '011_Packs.js'), 'utf8'), sandbox, { filename: '011_Packs.js' });
var Packs = sandbox.Packs;
var pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pack_vndly.json'), 'utf8'));

var failed = 0;
function eq(name, got, want) { var ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))); }
function count(rows, pred) { return rows.filter(pred).length; }
var byName = function(rows, n) { return rows.filter(function(f) { return f['Field name'] === n; })[0]; };

// 1. defaults: everything in, no answers
var p = Packs.plan(pack, {}, null, 'standard');
// add_checklists_to_wo is governed by an include-question; unanswered means no, so the default drops it (and its 2 lookup rows)
eq('default keeps every field except include-questions answered no', p.fields.length, pack.fields.length - 1);
eq('default keeps every rule', p.rules.length, pack.rules.length);
eq('default keeps only referenced lookup rows', p.lookups.length, pack.lookups.length - 2);
eq('default: include-questions answered no drop their field', !!byName(p.fields, 'add_checklists_to_wo'), false);
eq('default stamps', [p.stamps.pack_id, p.stamps.collection_mode], ['vndly_contractor_work_order', 'standard']);
eq('default warnings', p.warnings, []);
var withCk = Packs.plan(pack, { checklists: true }, null, 'standard');
eq('checklists=yes keeps add_checklists_to_wo', !!byName(withCk.fields, 'add_checklists_to_wo'), true);
eq('checklists=no drops its lookup table', count(p.lookups, function(l) { return l['Table name'] === 'add_checklists_to_wo'; }), 0);
eq('checklists=yes keeps its lookup table', count(withCk.lookups, function(l) { return l['Table name'] === 'add_checklists_to_wo'; }), 2);

// 2. required-effect questions
var q = Packs.plan(pack, { workday_connector: true, pay_groups: true }, null, 'standard');
eq('workday=yes makes client_contractor_id required', byName(q.fields, 'client_contractor_id')['Required'], true);
eq('pay_groups=yes makes pay_type required', byName(q.fields, 'pay_type')['Required'], true);
eq('pay_groups=yes makes pay_group required', byName(q.fields, 'pay_group')['Required'], true);
eq('unanswered leaves timekeeper_users optional', byName(q.fields, 'timekeeper_users')['Required'], false);
eq('plan does not mutate the pack', byName(pack.fields, 'pay_type')['Required'], false);

// 3. scope drops rules and lookups with their fields
var scope = pack.fields.map(function(f) { return f['Field name']; }).filter(function(n) { return n !== 'pay_type'; });
var s = Packs.plan(pack, {}, scope, 'standard');
eq('scope without pay_type drops the field', !!byName(s.fields, 'pay_type'), false);
eq('scope without pay_type drops the 5 rules that condition on it', pack.rules.length - s.rules.length, 5);
eq('scope without pay_type drops its lookup rows', count(s.lookups, function(l) { return l['Table name'] === 'pay_type'; }), 0);
eq('scope drop is warned', s.warnings.length, 5);

// 4. discovery clears Strict? on fields and rules
var strictPack = JSON.parse(JSON.stringify(pack));
strictPack.fields[0]['Strict?'] = true; strictPack.rules[0]['Strict?'] = true;
var d = Packs.plan(strictPack, {}, null, 'discovery');
eq('discovery clears field Strict?', d.fields[0]['Strict?'], false);
eq('discovery clears rule Strict?', d.rules[0]['Strict?'], false);
eq('standard keeps field Strict?', Packs.plan(strictPack, {}, null, 'standard').fields[0]['Strict?'], true);
var threw = false; try { Packs.plan(pack, {}, null, 'loose'); } catch (e) { threw = true; } eq('bad mode throws', threw, true);

// 5. _locate / _readTable on both layouts, via a fake sheet
function fakeSheet(rows) { return { getDataRange: function() { return { getValues: function() { return rows; } }; } }; }
var sonyLookups = [['5. Lookup tables'], ["grouped by 'Table name'"], [], [], ['Table name', '', 'Code', 'Value', 'Label', 'Parent value', 'Record active?', 'Project specific?'],
                   ['status', '', 'active', 'active', '', '', 'TRUE', 'FALSE'], ['', '', '', '', '', '', '', ''], ['status', '', 'ended', 'ended', '', '', true, false]];
var t1 = Packs._readTable(fakeSheet(sonyLookups), ['_pk_lookup_table_', 'Table name'], sandbox.PACK_LOOKUP_HEADERS, 'Table name');
eq('reads a lookups tab without a pk anchor (header row 5, spacer column)', [t1.length, t1[0]['Code'], t1[0]['Record active?'], t1[1]['Project specific?']], [2, 'active', true, false]);
var goldenLookups = [[], [], [], [], [], [], [], ['', '_pk_lookup_table_', 'Table name', 'Code', 'Value', 'Label', 'Parent value', 'Record active?', 'Project specific?'],
                     ['', 'uuid-1', 'status', 'active', 'active', '', '', true, false]];
var t2 = Packs._readTable(fakeSheet(goldenLookups), ['_pk_lookup_table_', 'Table name'], sandbox.PACK_LOOKUP_HEADERS, 'Table name');
eq('reads a lookups tab with the pk anchor (header row 8)', [t2.length, t2[0]['Table name'], t2[0]['Value']], [1, 'status', 'active']);
var fields4 = [[], [], [], [], [], ['Def', 'Primary key (UUID)', 'Expected header name'], ['Hint'], ['', '_pk_fields_'].concat(sandbox.PACK_FIELD_HEADERS),
               ['', '', 'Status', 'string', 'dropdown', 'desc', 'TRUE', false, false, 'status', '', '', '', '', '', '', 'FALSE', 'FALSE']];
var t3 = Packs._readTable(fakeSheet(fields4), ['_pk_fields_', 'Field name'], sandbox.PACK_FIELD_HEADERS, 'Field name');
eq('reads 4_fields by header names and coerces booleans', [t3[0]['Field name'], t3[0]['Required'], t3[0]['Lookup name'], t3[0]['Strict?']], ['Status', true, 'status', false]);
eq('no anchor -> empty', Packs._readTable(fakeSheet([['nothing', 'here']]), ['_pk_fields_'], sandbox.PACK_FIELD_HEADERS, 'Field name'), []);

console.log(failed ? failed + ' FAILED' : 'all passed');
process.exit(failed ? 1 : 0);
