'use strict';
/**
 * getSettings() <-> settings-schema.js sync assertion. (2026-08-22)
 *
 * THE FAILURE MODE. getSettings() in services/jobs.js is a hand-written
 * object literal. A settings-schema key that nobody remembers to map
 * there is invisible to runModel no matter what app_settings says and no
 * matter what the settings UI shows. The setting appears tunable, stores
 * fine, renders fine -- and does nothing.
 *
 * It has happened twice:
 *   - CATCHER_FRAMING_ENABLED was never surfaced, so the framing feature
 *     could not activate at all (recorded at services/jobs.js:294).
 *   - use_hand_conditional_sp_weight, sp_weight_r and sp_weight_l were
 *     stored, UI-wired, and unread until 2026-08-22.
 *
 * Both were found by hand, months apart. This closes it: the check runs
 * every morning ahead of the cron chain and says so when it drifts.
 *
 * WHY AN ALLOWLIST RATHER THAN A COUNT. Four ui_highlight_* keys are
 * deliberately absent from getSettings -- the model does not consume
 * them; the UI and frv-backtest read them straight from app_settings
 * (see the note at services/jobs.js:211). Asserting a count would break
 * on every legitimate schema addition; asserting against a named
 * allowlist means a NEW absence is always a real finding, and adding a
 * key to the allowlist is a deliberate, reviewable act.
 *
 * This is the same shape as the fail-loud guard in
 * parameter-sweep.applySweepOverrides and the family-keyed guard in
 * scripts/calibration-ab.js. Three instances of one defect -- a
 * hand-maintained key list that fails OPEN on anything it does not
 * recognise. Failing loudly is the fix in all three.
 */

// Schema keys the model is NOT expected to read. Every entry needs a
// reason, and adding one should be a conscious decision, not a way to
// silence the check.
const UI_ONLY_KEYS = {
  ui_highlight_ml_fav_min_pp:    'UI display threshold; read from app_settings by the UI and frv-backtest',
  ui_highlight_ml_dog_min_pp:    'UI display threshold; ditto',
  ui_highlight_tot_under_min_pp: 'UI display threshold; ditto',
  ui_highlight_tot_overs_enabled:'UI display toggle; ditto',
};

/**
 * @param settingsObj  the object getSettings() returned
 * @param schemaObj    the settings-schema map
 * @returns {{ok, missing, unexpectedlyAllowed, checked}}
 */
function checkSettingsSchemaSync(settingsObj, schemaObj) {
  const schemaKeys = Object.keys(schemaObj || {}).filter(k => {
    const e = schemaObj[k];
    return e && typeof e === 'object' && Object.prototype.hasOwnProperty.call(e, 'default');
  });
  // getSettings uppercases its keys; compare case-insensitively.
  const surfaced = new Set(Object.keys(settingsObj || {}).map(k => String(k).toUpperCase()));

  const missing = schemaKeys.filter(k =>
    !surfaced.has(k.toUpperCase()) && !Object.prototype.hasOwnProperty.call(UI_ONLY_KEYS, k));

  // An allowlisted key that IS surfaced means the allowlist is stale --
  // harmless, but it should not silently accumulate dead entries.
  const unexpectedlyAllowed = Object.keys(UI_ONLY_KEYS).filter(k => surfaced.has(k.toUpperCase()));

  return { ok: missing.length === 0, missing, unexpectedlyAllowed, checked: schemaKeys.length };
}

/**
 * Cron-friendly wrapper. Never throws -- a check that can abort the
 * morning chain is worse than the drift it detects.
 */
function logSettingsSchemaSync(settingsObj, schemaObj) {
  let r;
  try {
    r = checkSettingsSchemaSync(settingsObj, schemaObj);
  } catch (e) {
    console.warn('[settings-sync] check failed (non-fatal): ' + (e && e.message));
    return null;
  }
  if (r.ok && !r.unexpectedlyAllowed.length) {
    console.log('[settings-sync] OK  ' + r.checked + ' schema keys, all model-consumed keys surfaced');
  }
  if (!r.ok) {
    console.warn('[settings-sync] *** ' + r.missing.length + ' SCHEMA KEY(S) NOT READ BY getSettings() ***');
    r.missing.forEach(k => console.warn('[settings-sync]     ' + k
      + '  -- stored and UI-visible but INVISIBLE TO runModel; tuning it does nothing'));
    console.warn('[settings-sync]     fix: add it to the object literal in services/jobs.js getSettings(),'
      + ' or to UI_ONLY_KEYS in utils/settings-sync-check.js if the model genuinely should not read it');
  }
  if (r.unexpectedlyAllowed.length) {
    console.warn('[settings-sync] stale UI_ONLY_KEYS entries (now surfaced, can be removed): '
      + r.unexpectedlyAllowed.join(', '));
  }
  return r;
}

module.exports = { checkSettingsSchemaSync, logSettingsSchemaSync, UI_ONLY_KEYS };
