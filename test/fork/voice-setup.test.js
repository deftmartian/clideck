const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os'),{join}=require('node:path');
const {runSetup,parseSetupArgs}=require('../../src/fork/voice-setup');
test('offline voice setup check runs only the existing worker and rejects invalid flags',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-setup-check-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'.venv/bin'),{recursive:true});writeFileSync(join(dir,'.venv/bin/python3'),'fixture');
 const commands=[];await runSetup(['--voice-dir',dir,'--check'],async(...args)=>commands.push(args));
 assert.equal(commands.length,1);assert.equal(commands[0][1].at(-1),'--check');assert.ok(commands[0][1][0].endsWith('worker.py'));
 assert.throws(()=>parseSetupArgs(['--voice-dir']),/incomplete/);assert.throws(()=>parseSetupArgs(['--apply']),/Unknown/);
});
