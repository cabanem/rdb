/**
 * @file 000_Result.gs
 * Canonical Result factories. Single source of truth for what a Result
 * looks like across every SDC flow.
 *
 * Canonical shape:
 *   {
 *     ok:            boolean,
 *     flow:          string,         // 'provision' | 'validate' | 'portalInvite'
 *                                    //   | 'primaryKeySetup' | 'migration'
 *     correlationId: string,         // always present; flows generate at start
 *     message:       string,         // user-ready prose
 *     data:          Object | null,  // null on failure, object on success
 *     warnings:      string[],       // empty array on clean success
 *     error:         { stage: string, message: string } | null
 *   }
 *
 * Public:
 *   Result.ok(args)   -> Result
 *   Result.fail(args) -> Result
 *
 * Both factories validate required args and throw on missing fields.
 * Catching this at construction time beats discovering a malformed
 * Result in the container's UI layer.
 */

var Result = {};

// --- Public API ------------------------------------------------------

/**
 * Build a success Result.
 *
 * @param {Object}   args
 * @param {string}   args.flow            - One of the canonical flow names.
 * @param {string}   args.correlationId   - Caller-generated; tied to log lines.
 * @param {string}   args.message         - User-ready prose.
 * @param {Object}   [args.data=null]     - Flow-specific structured payload.
 * @param {string[]} [args.warnings=[]]   - Non-fatal issues; flat strings.
 * @returns {Object} canonical Result
 */
Result.ok = function(args) {
  Result._requireArgs(args, ['flow', 'correlationId', 'message'], 'ok');
  return {
    ok:            true,
    flow:          args.flow,
    correlationId: args.correlationId,
    message:       args.message,
    data:          args.data || null,
    warnings:      args.warnings || [],
    error:         null
  };
};

/**
 * Build a failure Result.
 *
 * Accepts either an Error instance (preferred - reads .stage and .message)
 * or a plain {stage, message} object. The Error path is the common case
 * because orchestrators tag errors via _stage and pass the caught Error
 * directly.
 *
 * @param {Object}       args
 * @param {string}       args.flow
 * @param {string}       args.correlationId
 * @param {string}       args.message       - User-ready prose.
 * @param {Error|Object} args.error         - Error or {stage, message}.
 * @param {string[]}     [args.warnings=[]]
 * @returns {Object} canonical Result
 */
Result.fail = function(args) {
  Result._requireArgs(args, ['flow', 'correlationId', 'message', 'error'], 'fail');

  var stage  = args.error.stage   || 'unknown';
  var errMsg = args.error.message || String(args.error);

  return {
    ok:            false,
    flow:          args.flow,
    correlationId: args.correlationId,
    message:       args.message,
    data:          null,
    warnings:      args.warnings || [],
    error:         { stage: stage, message: errMsg }
  };
};

// --- Private ---------------------------------------------------------

Result._requireArgs = function(args, required, factoryName) {
  if (!args) {
    throw new Error('Result.' + factoryName + ': args object is required.');
  }
  for (var i = 0; i < required.length; i++) {
    var k = required[i];
    if (args[k] === undefined || args[k] === null) {
      throw new Error('Result.' + factoryName + ': "' + k + '" is required.');
    }
  }
};