/**
 * @file 000_Stage.gs (SDC library)
 * Shared control-flow wrapper for orchestrator pipeline stages. Tags
 * thrown errors with the stage name so the orchestrator's outer
 * try/catch knows which stage failed without each stage having to
 * remember to tag itself.
 *
 * Replaces three byte-identical _stage helpers previously inlined in
 * Provision, Validate, and Portal.
 *
 * Pre-tagged errors keep their tag - the inner stage wins. This lets
 * library functions (e.g. Preflight.run) tag their own throws with a
 * more specific stage name, and the orchestrator's call-site tag
 * applies only when the inner code didn't pre-tag.
 *
 * Public:
 *   Stage.run(stageName, fn) -> * (whatever fn returns)
 *
 * Usage:
 *   var config = Stage.run('config', function() {
 *     return Config.build(ss);
 *   });
 *
 *   // If Config.build throws without a .stage property, the error
 *   // gets tagged with stage='config' before propagating.
 *   // If Config.build throws WITH a .stage property (e.g. 'schema-mismatch'),
 *   // that more specific tag is preserved.
 */

var Stage = {};

/**
 * Run fn() and tag any thrown error with stageName. Errors that already
 * carry a .stage property are left unchanged - the inner stage wins.
 *
 * @param {string}   stageName - The stage name to tag uncaught errors with.
 * @param {Function} fn        - Zero-argument function to execute.
 * @returns {*} Whatever fn returns.
 * @throws  Re-throws any error fn throws, with .stage set if it wasn't already.
 */
Stage.run = function(stageName, fn) {
  try {
    return fn();
  } catch (e) {
    if (!e.stage) e.stage = stageName;
    throw e;
  }
};