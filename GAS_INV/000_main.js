/**
 * Main.gs — orchestration.
 *
 * A run walks the phases in order, working until the time budget is spent, then
 * checkpoints (rows → sheet, cursor → Properties) and schedules itself to resume.
 *
 * Phases:  drive → manifests → executions → done
 */

const STATE_KEY = 'INVENTORY_STATE';
const PHASES = ['drive', 'manifests', 'executions', 'done'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Script Inventory')
    .addItem('Run full inventory', 'runInventory')
    .addItem('Resume interrupted run', 'continueInventory')
    .addSeparator()
    .addItem('Create Config sheet', 'setupConfigSheet')
    .addItem('Reset run state', 'resetInventory')
    .addToUi();
}

function runInventory() {
  clearResumeTriggers_();
  saveState_({ phase: 'drive', runId: new Date().toISOString() });
  continueInventory();
}

function resetInventory() {
  clearResumeTriggers_();
  saveState_({ phase: 'idle' });
  toast_('State cleared.');
}

/** Entry point for both the menu and the resume trigger. */
function continueInventory() {
  const cfg = getConfig();
  const state = loadState_();

  if (state.phase === 'idle' || state.phase === 'done') {
    toast_('Nothing to resume — use "Run full inventory".');
    return;
  }

  const deadline = Date.now() + cfg.TIME_BUDGET_SECONDS * 1000;
  const store = loadStore_(cfg);

  try {
    while (state.phase !== 'done' && Date.now() < deadline) {
      if (runPhase_(state.phase, cfg, state, store, deadline)) {
        state.phase = PHASES[PHASES.indexOf(state.phase) + 1];
      }
    }
  } finally {
    saveStore_(store);   // always persist partial progress, even on error
    saveState_(state);
  }

  if (state.phase === 'done') {
    clearResumeTriggers_();
    toast_(`Inventory complete: ${store.rows.size} projects.`);
  } else {
    scheduleResume_();
    toast_(`Checkpointed in phase "${state.phase}" — resuming in ~1 minute.`);
  }
}

function runPhase_(phase, cfg, state, store, deadline) {
  switch (phase) {
    case 'drive':      return scanDrive_(cfg, state, store, deadline);
    case 'manifests':  return scanManifests_(cfg, state, store, deadline);
    case 'executions': return scanExecutions_(cfg, state, store, deadline);
    default:           throw new Error('Unknown phase: ' + phase);
  }
}

// --- state & triggers --------------------------------------------------------

function loadState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  return raw ? JSON.parse(raw) : { phase: 'idle' };
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function scheduleResume_() {
  clearResumeTriggers_();
  ScriptApp.newTrigger('continueInventory').timeBased().after(60 * 1000).create();
}

function clearResumeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueInventory')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'Script Inventory'); } catch (e) { Logger.log(msg); }
}
