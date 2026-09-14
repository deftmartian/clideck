const {performance} = require('node:perf_hooks');
const {execFileSync} = require('node:child_process');
const {Module} = require('node:module');
const {join} = require('node:path');
const assert = require('node:assert/strict');
const {Screen} = require('../src/screen');
const baseline = new Module(join(__dirname,'../src/screen-baseline.js'),module);
baseline.filename = join(__dirname,'../src/screen-baseline.js');
baseline.paths = module.paths;
baseline._compile(execFileSync('git',['show','32bb23c:src/screen.js'],{encoding:'utf8'}),baseline.filename);
function run(Implementation) {
  const screen = new Implementation(120,40);
  screen.write(Array.from({length:500},(_,i)=>`History line ${i}: ${'word '.repeat(12)}\r\n`).join(''));
  const start = performance.now();
  for(let i=0;i<500;i++) {screen.write(`\r\x1b[2KProgress ${i}`);for(let n=0;n<5;n++)screen.lines();}
  return {ms:performance.now()-start,lines:screen.lines()};
}
run(baseline.exports.Screen);run(Screen);
const times = {baseline:[],cached:[]};
for(let i=0;i<5;i++) {const before=run(baseline.exports.Screen),after=run(Screen);assert.deepEqual(after.lines,before.lines);times.baseline.push(before.ms);times.cached.push(after.ms);}
const median = list => list.sort((a,b)=>a-b)[Math.floor(list.length/2)];
console.log(JSON.stringify({scenario:'500 progress updates, five provider screen reads per update',baselineMs:median(times.baseline),cachedMs:median(times.cached),sameScreen:true},null,2));
