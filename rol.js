/**
 * @file Workato restart-ordering library
 * @description Derives topological start/stop order for a recipe corpus from call edges extracted by WorkatoGraphLib. Pure logic — no
 *              UrlFetchApp, no I/O. The only GAS dependency (SHA-256 via Utilities) is injectable for testing.
 *
 * Design invariants:
 *  - The graph is DERIVED at execution time, never cached across runs.
 *  - Ambiguity is fatal: cycles, unresolvable refs, and dynamic callees ABORT the ordering (strict) rather than guess. 
 *    Half-ordered restarts are worse than no restart.
 *  - User input enters as CONSTRAINT PINS (extra edges) and EXCLUSIONS (manage:false), never as a hand-maintained full ordering.
 *
 * @author emily.cabaniss@randstadsourceright.com
 * 
 * See the technical README here: https://docs.google.com/document/d/13Su2kfsxK8RoGqnvsXCETvOEyR3i9CAGfHuZ8E5NXBc/edit?tab=t.mgfr8y2cldif
 * @version 0.3.0  (adds levels() — Kahn rounds as an array of levels, for consumers that want the structure, not a flat order)
 */

// -------------------------------------------------------------------------------------------------------
// PUBLIC FACTORY
// -------------------------------------------------------------------------------------------------------

/**
 * Creates a new Orderer.
 * @param {Object} [options]
 * @param {boolean} [options.strict=true]  - Abort on ambiguity (recommended for watchdog).
 * @param {Function} [options.sha256]      - Injectable hasher (hex string in, hex string out). Defaults to GAS Utilities SHA-256 when available.
 * @return {Orderer}
 */
function newOrderer(options) {
  return new Orderer(options);
}

// -------------------------------------------------------------------------------------------------------
// CUSTOM ERROR
// -------------------------------------------------------------------------------------------------------

/** Raised when the corpus cannot be honestly ordered. Carries findings for the report. */
class OrderingError extends Error {
  constructor(message, findings) {
    super(message);
    this.name = 'OrderingError';
    this.findings = findings || [];
  }
}

// -------------------------------------------------------------------------------------------------------
// PRIMARY CLASS
// -------------------------------------------------------------------------------------------------------

class Orderer {
  constructor(options = {}) {
    this.options = {
      strict: (options.strict !== undefined) ? options.strict : true,
      sha256: options.sha256 || Orderer._defaultSha256
    };
  }

  // ----- Public interface -------------------------------------------------

  /**
   * Builds the corpus dependency graph from an analyzer + manifest.
   *
   * @param {Object} analyzer - WorkatoGraphLib RecipeAnalyzer (cache-primed).
   * @param {Array<Object>} manifest - Rows of:
   *   { id: string|number, name?: string, manage?: boolean, after?: Array<string|number> }
   *   `after` = constraint pins: this recipe starts AFTER the listed recipe IDs.
   * @returns {Object} { nodes, edges, pins, findings }
   *   nodes:     Array<string> managed recipe IDs
   *   edges:     Array<[callerId, calleeId]> deduped strong edges within the manifest
   *   findings:  Array<{level, code, detail}> — everything the graph refused to act on
   */
  buildCorpusGraph(analyzer, manifest) {
    const findings = [];
    const managed = (manifest || []).filter(m => m.manage !== false);
    const nodeIds = managed.map(m => String(m.id));
    const nodeSet = new Set(nodeIds);

    // Name index for resolving symbolic refs ({zip_name, name} from exports).
    const nameIndex = new Map();
    (manifest || []).forEach(m => {
      if (m.name) nameIndex.set(String(m.name).trim().toLowerCase(), String(m.id));
    });

    const edgePairs = [];
    const seen = new Set();

    for (const id of nodeIds) {
      const rawEdges = analyzer.getCallEdges(id); // throws in analyzer strict mode
      for (const e of rawEdges) {
        const resolution = this._resolveEdge(e, nameIndex, findings);
        if (!resolution) continue; // finding already recorded

        const callee = resolution.calleeId;
        if (!nodeSet.has(callee)) {
          // Callee outside the managed set — itself a finding: either an
          // unmanaged dependency (add it to the manifest!) or a stale ref.
          findings.push({
            level: 'warn', code: 'EXTERNAL_CALLEE',
            detail: `${e.parent_recipe_id} -> ${callee} (` +
                    `${e.step_name} @ ${e.step_path}) callee not in manifest`
          });
          continue;
        }

        const sig = `${String(e.parent_recipe_id)}->${callee}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          edgePairs.push([String(e.parent_recipe_id), callee]);
        }
      }
    }

    // Merge constraint pins as synthetic edges: "X after Y" == X depends on Y
    // == same direction as a call edge [X(caller-like), Y(callee-like)].
    const pins = [];
    for (const m of managed) {
      for (const dep of (m.after || [])) {
        const depId = String(dep);
        if (!nodeSet.has(depId)) {
          findings.push({
            level: 'error', code: 'PIN_TARGET_UNKNOWN',
            detail: `Pin on ${m.id}: after=${depId} is not a managed recipe`
          });
          continue;
        }
        const sig = `${String(m.id)}->${depId}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          edgePairs.push([String(m.id), depId]);
          pins.push([String(m.id), depId]);
        }
      }
    }

    if (this.options.strict) {
      const fatal = findings.filter(f => f.level === 'error');
      if (fatal.length) {
        throw new OrderingError(
          `Corpus graph has ${fatal.length} fatal finding(s); refusing to order.`, findings);
      }
    }

    return { nodes: nodeIds, edges: edgePairs, pins, findings };
  }

  /**
   * Kahn's algorithm. Returns START order (callees first).
   * Reverse the result for STOP order (callers first).
   *
   * Determinism note: ties are broken by ascending recipe ID so the same graph always yields the same order — diffs stay meaningful.
   *
   * @param {Array<string>} nodes
   * @param {Array<[string,string]>} edges - [callerId, calleeId]
   * @returns {Array<string>} start order
   * @throws {OrderingError} on cycle, naming the members.
   */
  topoSort(nodes, edges) {
    const inDeg = {}, children = {};
    nodes.forEach(id => { inDeg[id] = 0; children[id] = []; });

    edges.forEach(([caller, callee]) => {
      if (!(caller in inDeg) || !(callee in inDeg)) {
        throw new OrderingError(
          `Edge references node outside the graph: ${caller} -> ${callee}`);
      }
      children[callee].push(caller); // callee unblocks its callers
      inDeg[caller]++;
    });

    // Callees have in-degree 0 -> emitted first -> start order falls out free.
    const queue = nodes.filter(id => inDeg[id] === 0).sort(Orderer._byIdAsc);
    const order = [];

    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      const unblocked = [];
      children[id].forEach(c => { if (--inDeg[c] === 0) unblocked.push(c); });
      unblocked.sort(Orderer._byIdAsc).forEach(c => Orderer._sortedInsert(queue, c));
    }

    if (order.length !== nodes.length) {
      const cycleMembers = nodes.filter(id => !order.includes(id));
      throw new OrderingError(
        `Cycle detected among recipes: ${cycleMembers.join(', ')}. ` +
        `Refusing to produce a partial order.`,
        [{ level: 'error', code: 'CYCLE', detail: cycleMembers.join(', ') }]);
    }
    return order;
  }

  /**
   * Kahn's algorithm, but returning the ROUNDS instead of a flat order: level[0] = every recipe with no
   * callees, level[1] = every recipe whose callees are all in level[0], and so on. Same graph rules and
   * the same cycle behaviour as topoSort(); flatten the result to get an order equivalent to topoSort().
   *
   * A level is the honest unit of "start dependency": recipes in one level do not depend on each other,
   * so anything that orders them further is a preference, not a constraint.
   *
   * @param {Array<string>} nodes
   * @param {Array<[string,string]>} edges - [callerId, calleeId]
   * @returns {Array<Array<string>>} levels, callees first; ids within a level sorted by _byIdAsc
   * @throws {OrderingError} on cycle, naming the members.
   */
  levels(nodes, edges) {
    const inDeg = {}, children = {};
    nodes.forEach(id => { inDeg[id] = 0; children[id] = []; });
    edges.forEach(([caller, callee]) => {
      if (!(caller in inDeg) || !(callee in inDeg)) {
        throw new OrderingError(`Edge references node outside the graph: ${caller} -> ${callee}`);
      }
      children[callee].push(caller);
      inDeg[caller]++;
    });

    const out = [];
    let frontier = nodes.filter(id => inDeg[id] === 0).sort(Orderer._byIdAsc);
    let emitted = 0;
    while (frontier.length) {
      out.push(frontier);
      emitted += frontier.length;
      const next = [];
      frontier.forEach(id => children[id].forEach(c => { if (--inDeg[c] === 0) next.push(c); }));
      frontier = next.sort(Orderer._byIdAsc);
    }

    if (emitted !== nodes.length) {
      const placed = new Set(out.flat());
      const cycleMembers = nodes.filter(id => !placed.has(id));
      throw new OrderingError(
        `Cycle detected among recipes: ${cycleMembers.join(', ')}. ` +
        `Refusing to produce a partial order.`,
        [{ level: 'error', code: 'CYCLE', detail: cycleMembers.join(', ') }]);
    }
    return out;
  }

  /**
   * Canonical SHA-256 fingerprint of the edge set (call edges + pins). Same recipe as SDC config fingerprinting: sort, serialize, hash.
   * Store it; when it changes between runs, log the diff before acting — architectural drift becomes an observable event.
   * @param {Array<[string,string]>} edges
   * @returns {string} hex digest
   */
  fingerprint(edges) {
    const canonical = (edges || [])
      .map(([a, b]) => `${a}->${b}`)
      .sort()
      .join('|');
    return this.options.sha256(canonical);
  }

  /**
   * Human-readable diff of two edge sets, for the drift log.
   * @returns {{added: Array<string>, removed: Array<string>}}
   */
  diffEdges(prevEdges, currEdges) {
    const key = e => `${e[0]}->${e[1]}`;
    const prev = new Set((prevEdges || []).map(key));
    const curr = new Set((currEdges || []).map(key));
    return {
      added:   [...curr].filter(k => !prev.has(k)).sort(),
      removed: [...prev].filter(k => !curr.has(k)).sort()
    };
  }

  // ----- Internal utilities -----------------------------------------------

  /**
   * Resolves one raw analyzer edge to a callee ID, or records a finding.
   * Handles the three ref kinds produced by the hardened extractor:
   *   id       -> use directly
   *   symbolic -> resolve by name via manifest index (export-format inputs)
   *   dynamic  -> NEVER orderable; error in strict, warn otherwise
   * Weak edges (ID-shaped key on a non-call step) are logged and skipped.
   * @private
   */
  _resolveEdge(e, nameIndex, findings) {
    if (e.strength === 'weak') {
      findings.push({
        level: 'info', code: 'WEAK_EDGE',
        detail: `${e.parent_recipe_id}: id-like key '${e.id_key}' on non-call step ` +
                `'${e.step_name}' (${e.provider}) @ ${e.step_path} — observed, not ordered`
      });
      return null;
    }

    if (e.strength === 'dynamic') {
      findings.push({
        level: this.options.strict ? 'error' : 'warn', code: 'DYNAMIC_CALLEE',
        detail: `${e.parent_recipe_id}: runtime-dispatched call at ` +
                `'${e.step_name}' @ ${e.step_path} — statically unorderable`
      });
      return null;
    }

    const ref = e.child_ref || (e.child_recipe_id
      ? { kind: 'id', id: String(e.child_recipe_id) } : null);
    if (!ref) return null;

    if (ref.kind === 'id') return { calleeId: String(ref.id) };

    if (ref.kind === 'symbolic') {
      const hit = nameIndex.get(String(ref.name || '').trim().toLowerCase());
      if (hit) return { calleeId: hit };
      findings.push({
        level: this.options.strict ? 'error' : 'warn', code: 'UNRESOLVED_SYMBOLIC',
        detail: `${e.parent_recipe_id}: symbolic callee '${ref.name}' ` +
                `(${ref.zip_name || 'no zip_name'}) not found in manifest name index`
      });
      return null;
    }

    return null;
  }

  /** @private Deterministic tie-break: numeric-aware ascending ID. */
  static _byIdAsc(a, b) {
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a) < String(b) ? -1 : 1;
  }

  /** @private Insert keeping queue sorted by _byIdAsc. */
  static _sortedInsert(queue, id) {
    let i = 0;
    while (i < queue.length && Orderer._byIdAsc(queue[i], id) < 0) i++;
    queue.splice(i, 0, id);
  }

  /** @private GAS SHA-256; overridable for tests / non-GAS runtimes. */
  static _defaultSha256(str) {
    if (typeof Utilities !== 'undefined' && Utilities.computeDigest) {
      const bytes = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
      return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
    }
    // Fallback (test environments without GAS): NOT cryptographic, just stable.
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return 'nogas_' + (h >>> 0).toString(16);
  }
}
if (typeof module !== 'undefined') module.exports = { Orderer, OrderingError, newOrderer };
