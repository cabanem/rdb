// Node harness: three-recipe fixture (entry -> orchestrator -> leaf, plus a second leaf), a rename, and a cycle.
const vm = require('vm'), fs = require('fs');
const gctx = { console, Map, Set, JSON, Array, Object, String, Number }; vm.createContext(gctx);
vm.runInContext(fs.readFileSync('../libs/lib_workato-graph/lib_workato-graph/Code.js','utf8') + '\nthis.newAnalyzer = newAnalyzer;', gctx);
const Graph = gctx;
const Order = require('./OrderLib_Code.js');
const { buildRecipeOrder } = require('./RecipeOrder.js');
const assert = require('assert');

const fn = (id, name, calls) => ({ id, name, code: {
  provider: 'workato_recipe_function', name: 'execute',
  block: calls.map(c => ({ provider: 'workato_recipe_function', name: 'call_recipe', input: { flow_id: String(c) } }))
}});
const entry = (id, name, calls) => ({ id, name, code: {
  provider: 'workato_api_platform', name: 'new_request',
  block: [{ keyword: 'if', block: calls.map(c => ({ provider: 'workato_recipe_function', name: 'call_recipe_async', input: { flow_id: String(c) } })) }]
}});

function run(recipes) {
  const analyzer = Graph.newAnalyzer({ get: () => { throw new Error('no network'); } }, { STRICT: true });
  analyzer.primeCache(recipes);
  return buildRecipeOrder(recipes, analyzer, Order.newOrderer({ strict: true }));
}

// 1. Levels and tie-break
let r = run([entry(4, 'API-00', [3]), fn(3, 'INV-01', [1, 2]), fn(2, 'UTL-01', []), fn(1, 'OBS-01', [])]);
assert.deepStrictEqual(r.rows.map(x => [x.recipe_name, x.position, x.callable]),
  [['OBS-01', 1, true], ['UTL-01', 1, true], ['INV-01', 2, true], ['API-00', 3, false]]);
assert.strictEqual(r.levelCount, 3);
assert.strictEqual(r.edges.length, 3, 'async call inside an IF still counts as an edge');

// 2. Rename moves the row fingerprint but not the edge fingerprint
const before = r;
r = run([entry(4, 'API-00', [3]), fn(3, 'INV-01', [1, 2]), fn(2, 'UTL-01', []), fn(1, 'OBS-01 (renamed)', [])]);
assert.strictEqual(r.edgeFingerprint, before.edgeFingerprint);
assert.notStrictEqual(r.rowFingerprint, before.rowFingerprint);

// 3. Cycle refuses, naming members
assert.throws(() => run([fn(1, 'A', [2]), fn(2, 'B', [1]), fn(3, 'C', [])]), /Cycle detected among recipes: 1, 2/);

// 4. Callee outside the folder refuses
assert.throws(() => run([fn(1, 'A', [99])]), /leave the golden folder/);

// 5. Duplicate names refuse
assert.throws(() => run([fn(1, 'A', []), fn(2, 'A', [])]), /Duplicate recipe names/);

// 6. Datapill callee refuses (strict orderer)
assert.throws(() => run([fn(1, 'A', ['#{_dp(...)}'])]), /fatal finding/);

console.log('all 6 cases pass');
