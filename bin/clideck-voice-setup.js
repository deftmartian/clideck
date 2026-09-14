#!/usr/bin/env node
'use strict';
const { runSetup } = require('../src/fork/voice-setup');
runSetup(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
