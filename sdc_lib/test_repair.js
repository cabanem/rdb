// End-to-end check of the schema-1.7 repair against the real gas_export.json grids.
// Mocks just enough of SpreadsheetApp for Layout.verify, Migrations, PrimaryKey and Variant.
const fs = require('fs'), vm = require('vm'), path = require('path');
const LIB = __dirname;
const gas = JSON.parse(fs.readFileSync(path.join(__dirname, 'gas_export.json'), 'utf8'));

// ---------- mock Sheets ----------
class Range {
  constructor(sheet, r, c, nr = 1, nc = 1) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValue() { return this.sheet._get(this.r, this.c); }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet._get(this.r + i, this.c + j)); o.push(row); } return o; }
  setValue(v) { this.sheet._set(this.r, this.c, v); return this; }
  setValues(vv) { vv.forEach((row, i) => row.forEach((v, j) => this.sheet._set(this.r + i, this.c + j, v))); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._set(this.r + i, this.c + j, ''); return this; }
  protect() { const p = { setDescription: () => p, removeEditors: () => p, getEditors: () => [], canDomainEdit: () => false, setDomainEdit: () => p, setWarningOnly: () => p }; return p; }
  getColumn() { return this.c; } getRow() { return this.r; }
}
class Sheet {
  constructor(name, grid) { this.name = name; this.grid = grid.map(r => r.slice()); this.structural = []; }
  getName() { return this.name; }
  _get(r, c) { const row = this.grid[r - 1]; return row && c - 1 < row.length ? row[c - 1] : ''; }
  _set(r, c, v) { while (this.grid.length < r) this.grid.push([]); const row = this.grid[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return new Range(this, 1, 1, this.grid.length, this.getLastColumn()); }
  getLastRow() { let last = 0; this.grid.forEach((row, i) => { if (row.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; }); return last; }
  getLastColumn() { return Math.max(0, ...this.grid.map(r => r.length)); }
  getMaxRows() { return this.grid.length; }
  deleteColumn(c) { this.structural.push('deleteColumn(' + c + ')'); this.grid.forEach(row => { if (row.length >= c) row.splice(c - 1, 1); }); }
  insertColumnBefore(c) { this.structural.push('insertColumnBefore(' + c + ')'); this.grid.forEach(row => { while (row.length < c - 1) row.push(''); row.splice(c - 1, 0, ''); }); }
  hideColumns() {}
}
class Spreadsheet {
  constructor(sheets) { this.sheets = sheets; }
  getSheetByName(n) { return this.sheets[n] || null; }
  getId() { return 'TEST'; }
  getSpreadsheetTimeZone() { return 'UTC'; }
}
const build = () => new Spreadsheet(Object.fromEntries(Object.entries(gas).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, new Sheet(k, v)])));

// ---------- load library ----------
let uuidN = 0;
const ctx = {
  console, Utilities: { getUuid: () => 'uuid-' + String(++uuidN).padStart(4, '0'), computeDigest: () => [], DigestAlgorithm: {}, Charset: {}, formatDate: () => '', newBlob: () => ({}) },
  SpreadsheetApp: {}, DriveApp: {}, LockService: {}, Session: { getActiveUser: () => ({ getEmail: () => 't@x' }) }, MimeType: {}, UrlFetchApp: {}, module: undefined,
};
vm.createContext(ctx);
for (const f of fs.readdirSync(LIB).filter(f => /^\d{3}_.*\.js$/.test(f)).sort()) vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx, { filename: f });
ctx.Log.forCorrelation = () => () => {};                           // no _script_logs sheet in the mock
const { Layout, MIGRATION_CHAIN, PrimaryKey, Variant, VARIANT_LAYOUT, PRIMARY_KEY_COLUMNS, SDC_SCHEMA_VERSION } = ctx;
const step = MIGRATION_CHAIN.find(s => s.from === '1.6' && s.to === '1.7');
let fails = 0; const check = (ok, msg) => { console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) fails++; };

// ---------- 1. verify on the broken workbook ----------
let ss = build();
console.log('\n[1] Layout.verify on the exported (broken) workbook, library schema ' + SDC_SCHEMA_VERSION);
let v = Layout.verify(ss);
v.problems.forEach(p => console.log('     - ' + p));
check(!v.ok, 'reports problems');
check(v.problems.some(p => p.startsWith('6_variants!B5')) && v.problems.some(p => /cast sheet/.test(p)), 'names 6_variants!B5 and the stray PK header');
check(v.problems.some(p => p.startsWith('4_complex_validations!B10')), 'names 4_complex_validations!B10');
check(v.problems.some(p => p.startsWith('5_lookups!B5')), 'names 5_lookups!B5');

// ---------- 2. migrate ----------
console.log('\n[2] Migration 1.6 -> 1.7');
let res = step.run(ss);
res.changed.forEach(c => console.log('     changed: ' + c));
res.notes.forEach(n => console.log('     note:    ' + n));
check(ss.sheets['6_variants'].grid[4][1] === 'All fields' && ss.sheets['6_variants'].grid[4][6] === 'Variant_1', '6_variants: All fields at B, Variant_1 at G');
check(ss.sheets['4_complex_validations'].grid[9][1] === '_pk_rules_' && ss.sheets['4_complex_validations'].grid[9][2] === 'Target field', '4_complex_validations: _pk_rules_ at B, Target field at C');
check(ss.sheets['5_lookups'].grid[4][1] === '_pk_lookup_table_' && [5, 6, 7].every(i => ss.sheets['5_lookups'].grid[i][1] === ''), '5_lookups: header at B5, rows 6-8 PK cells cleared');
check(ss.sheets['4_fields'].structural.length === 0 && ss.sheets['3_users'].structural.length === 0, 'no structural change to 4_fields / 3_users');

console.log('\n[3] Layout.verify after migration');
v = Layout.verify(ss); v.problems.forEach(p => console.log('     - ' + p));
check(v.ok, 'clean');

console.log('\n[4] Migration is idempotent');
const before = JSON.stringify(Object.values(ss.sheets).map(s => s.grid));
res = step.run(ss);
check(res.changed.length === 0 && JSON.stringify(Object.values(ss.sheets).map(s => s.grid)) === before, 'second run changes nothing (' + res.notes.length + ' notes)');

// ---------- 5. backfill ----------
console.log('\n[5] PrimaryKey.backfill after migration');
const bf = PrimaryKey.backfill(ss);
console.log('     stamped: ' + JSON.stringify(bf.stamped));
check(bf.stamped['4_complex_validations'] === 10, 'all 10 rules stamped');
check(bf.stamped['5_lookups'] === 3, 'the 3 lookup rows that held note text stamped');
check(bf.stamped['4_fields'] === 0 && bf.stamped['3_users'] === 0, 'nothing re-stamped on 4_fields / 3_users');
check(!('6_variants' in bf.stamped), '6_variants no longer in the PK set');
const rule1 = ss.sheets['4_complex_validations'].grid[10];
check(/^uuid-/.test(rule1[1]) && rule1[2] === 'org_department', 'first rule row (org_department) has a UUID in B');

// ---------- 6. variant extraction ----------
console.log('\n[6] Variant._extractIncludedFields on the repaired 6_variants');
const inc = Variant._extractIncludedFields(ss.sheets['6_variants'].grid, 1);
const arr = [...inc];
check(inc.size === 149 && arr[0] === 'Status' && arr[148] === 'ContractorCustomField: MIIS ID', '149 field NAMES, first "Status"');
const incBroken = Variant._extractIncludedFields(build().sheets['6_variants'].grid, 1);
console.log('     (for contrast, on the broken sheet the same call yields ' + incBroken.size + ' included fields -> every variant JSON was being emptied)');

// ---------- 7. setupColumns can no longer restructure ----------
console.log('\n[7] PrimaryKey.setupColumns on the repaired workbook');
const sc = PrimaryKey.setupColumns(ss);
check(sc.ok, 'ok: ' + (sc.data ? sc.data.configured.join(', ') : sc.message));
check(Object.values(ss.sheets).every(s => s.structural.filter(x => x.startsWith('insert')).length === 0), 'no column inserted anywhere');

console.log('\n[8] setupColumns against a deliberately wrong PRIMARY_KEY_COLUMNS entry (the pre-1.8 accident)');
const bad = { sheetName: '6_variants', colIndex: 1, fieldName: '_pk_variants_', dataStartRow: 6, keyColIndex: 2, keyHeader: 'All fields' };
let threw = null; try { PrimaryKey._ensureColumn(ss.sheets['6_variants'], bad); } catch (e) { threw = e.message; }
console.log('     -> ' + threw);
check(threw && /Refusing to insert/.test(threw) && ss.sheets['6_variants'].grid[4][1] === 'All fields', 'throws instead of inserting; sheet untouched');

console.log('\n[9] _ensureColumn "claim" and "refuse" branches (fresh-template paths)');
const lkCfg = PRIMARY_KEY_COLUMNS.find(c => c.sheetName === '5_lookups');
let s9 = build().sheets['5_lookups'];
for (let r = 6; r <= 8; r++) s9._set(r, 2, '');                    // pristine template: blank header, blank column
PrimaryKey._ensureColumn(s9, lkCfg);
check(s9.grid[4][1] === '_pk_lookup_table_' && s9.structural.length === 0, 'blank header + clean column -> header written in place, nothing structural');
check(s9.grid[3][1] === 'Do not edit.' && s9.grid[2][1] === 'Primary key (UUID)', 'note cells written above only because they were blank');
s9 = build().sheets['5_lookups']; s9._set(7, 2, 'hello');
threw = null; try { PrimaryKey._ensureColumn(s9, lkCfg); } catch (e) { threw = e.message; }
check(/Refusing to claim/.test(threw || '') && s9.grid[4][1] === '', 'non-UUID content below a blank header -> refuses: ' + threw);
s9 = build().sheets['5_lookups']; s9._set(5, 4, '_pk_lookup_table_');
threw = null; try { PrimaryKey._ensureColumn(s9, lkCfg); } catch (e) { threw = e.message; }
check(/declares column 2/.test(threw || '') && s9.structural.length === 0, 'header found in another column -> refuses: ' + threw);

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
