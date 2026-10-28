const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {validateNative}=require('../../src/fork/update-check');
test('updater refuses stale, absent or unsupported native resume metadata',t=>{
 const dir=mkdtempSync(join(tmpdir(),'update-native-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'native.jsonl');writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id:'real-id',cwd:'/work'}})+'\n');
 const entry={id:'pane',name:'conversation',provider:'codex',cwd:'/work',resumeHandle:'real-id',transcriptPath:path};
 assert.doesNotThrow(()=>validateNative([entry],['pane']));
 assert.throws(()=>validateNative([{...entry,resumeHandle:'stale-id'}],['pane']),/mismatch/);
 assert.throws(()=>validateNative([{...entry,resumeHandle:''}],['pane']),/Missing/);
 assert.throws(()=>validateNative([{...entry,provider:'shell'}],['pane']),/not verified/);
 assert.throws(()=>validateNative([],['pane']),/not saved/);
});
