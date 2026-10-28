const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('fs');
const {join}=require('path');
const {tmpdir}=require('os');
const {waitForNonemptyFile}=require('../src/transcript-file');

test('transcript created immediately after waiting cannot be missed by watcher initialization',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'clideck-transcript-race-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'transcript.jsonl');const ready=waitForNonemptyFile(path,40);
 writeFileSync(path,'{}\n');assert.equal(await ready,true);
});

test('empty and missing transcripts still time out',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'clideck-transcript-empty-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'empty.jsonl');writeFileSync(path,'');
 assert.equal(await waitForNonemptyFile(path,10),false);
 assert.equal(await waitForNonemptyFile(join(dir,'missing'),10),false);
});
