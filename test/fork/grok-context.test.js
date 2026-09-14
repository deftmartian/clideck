const test=require('node:test'), assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,renameSync,rmSync}=require('node:fs');
const {join}=require('node:path');const {tmpdir}=require('node:os');
const {readGrokContext,watchGrokContext}=require('../../src/fork/grok-context');
test('Grok reports native model/context, tolerates partial writes and follows atomic replacement',async t=>{
 const root=mkdtempSync(join(tmpdir(),'grok-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'chat_history.jsonl');const signals=join(root,'signals.json');
 writeFileSync(signals,JSON.stringify({contextTokensUsed:156000,contextWindowTokens:500000}));
 writeFileSync(join(root,'summary.json'),JSON.stringify({current_model_id:'grok-4.6'}));
 const initial=readGrokContext(path);assert.equal(initial.model,'grok-4.6');assert.equal(initial.usage.percent,31);assert.equal(initial.usage.estimated,false);
 const usages=[],models=[];const stop=watchGrokContext(path,v=>usages.push(v),{onModel:m=>models.push(m),debounceMs:5,pollMs:20});t.after(stop);
 assert.deepEqual(models,['grok-4.6']);
 writeFileSync(signals,'{');assert.equal(readGrokContext(path).usage,null);
 writeFileSync(signals+'.new',JSON.stringify({contextTokensUsed:10000,contextWindowTokens:500000}));renameSync(signals+'.new',signals);
 const deadline=Date.now()+1000;while(usages.at(-1)?.usedTokens!==10000&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(usages.at(-1).percent,2,'compaction lowers context without inventing a cumulative count');
 stop();const count=usages.length;writeFileSync(signals,JSON.stringify({contextTokensUsed:20000,contextWindowTokens:500000}));await new Promise(r=>setTimeout(r,40));assert.equal(usages.length,count);
});
