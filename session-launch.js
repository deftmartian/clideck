'use strict';

const { parseCommand } = require('./utils');
const { applyPresetScreenArgs } = require('./preset-screen');
const { withCliDeckGuide } = require('./agent-session-guide');

function sessionLaunchParts(cmd, preset, { touchUi = false, commandText } = {}) {
  const source = commandText != null ? commandText : cmd?.command;
  const parts = parseCommand(source);
  return withCliDeckGuide(applyPresetScreenArgs(parts, preset, !!touchUi), preset?.presetId);
}

module.exports = { sessionLaunchParts };
