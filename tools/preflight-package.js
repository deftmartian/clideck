const { preflight } = require('../src/fork/package-check');
preflight(require('node:path').resolve(process.argv[2] || '.')).catch(error => { console.error(error); process.exitCode=1; });
