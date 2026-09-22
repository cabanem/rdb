/**
 * Description parser wrappers (library identifier: DP).
 * Menu items resolve in the container's global scope, so each library entry point needs a same-named wrapper here.
 * The library reads its own Script Properties, not this project's, so the DP_* properties are passed in.
 */
function dpScan()       { DP.dpScan(dpShimProps_()); }
function dpApply()      { DP.dpApply(dpShimProps_()); }
function dpAcceptHigh() { DP.dpAcceptHigh(dpShimProps_()); }
function dpClear()      { DP.dpClear(dpShimProps_()); }
function dpRunTests()   { DP.dpRunTests(); }

/** Only the DP_* properties are meaningful to the library; it ignores the rest. */
function dpShimProps_() {
  var all = PropertiesService.getScriptProperties().getProperties(), out = {};
  Object.keys(all).forEach(function (k) { if (/^DP_/.test(k)) out[k] = all[k]; });
  return out;
}
