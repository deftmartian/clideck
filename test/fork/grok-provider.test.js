const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('fs');
const {tmpdir}=require('os');
const {join,dirname}=require('path');
const {grokProvider,transcriptPath,latestReply}=require('../../src/fork/grok-provider');
const {createCustomCommandProvider}=require('../../src/custom-command');

test('Grok launch keeps account flags, injects guide, resumes and uses minimal touch UI',t=>{
 const root=mkdtempSync(join(tmpdir(),'grok-provider-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const provider=createCustomCommandProvider({providerId:'grok',command:'grok --permission-mode bypassPermissions --sandbox off',env:{ACCOUNT:'fixture'}});
 const launch=provider.createLaunch({port:1234,grokConfigRoot:root,agentGuide:'guide',touchUi:true,resumeHandle:'old-id',hookToken:'fresh'});
 assert.deepEqual(launch.args,['--permission-mode','bypassPermissions','--sandbox','off','--minimal','--resume','old-id','--rules','guide']);
 assert.equal(launch.nativeScroll,true);
 assert.equal(launch.env.ACCOUNT,'fixture');assert.equal(launch.env.CLIDECK_GROK_LAUNCH,'fresh');
 assert.equal(grokProvider.supportsAsk,true);
});

test('Grok canonical reply ignores tool messages and never reuses the preceding user turn',t=>{
 const root=mkdtempSync(join(tmpdir(),'grok-transcript-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=transcriptPath('/tmp/work','00000000-0000-0000-0000-000000000001',root);mkdirSync(dirname(path),{recursive:true});
 const rows=[{type:'user',content:'question'},{type:'assistant',content:'tool preamble',tool_calls:[{}]},{type:'tool_result',content:'result'},{type:'assistant',content:'Canonical answer'}];
 const save=()=>writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');save();
 assert.equal(latestReply(path),'Canonical answer');rows.push({type:'user',content:'new question'});save();assert.equal(latestReply(path),'');
 assert.equal(transcriptPath('/tmp/work','../../outside',root),'');
});

test('Grok recognizes both the boxed desktop prompt and the minimal mobile footer',()=>{
 assert.equal(grokProvider.screen.hasInputPrompt(['│ ❯                    │']),true);
 assert.equal(grokProvider.screen.hasInputPrompt(['Enter:send  Alt+Enter:newline']),true);
 assert.equal(grokProvider.screen.hasInputPrompt(['Working on a task']),false);
});

test('Grok ignores missing and stale launch tokens after restart',async()=>{
 const {handleLegacyHook}=require('../../src/fork/grok-provider');let calls=0;
 const session={provider:{id:'grok'},hookToken:'new-launch',cwd:'/tmp',launchOptions:{},handleHook:()=>calls++,recordResumeMetadata:()=>{}};
 const server={host:'127.0.0.1',sessions:new Map([['pane',session]]),persistence:{recordResumeMetadata:()=>{}}};
 for(const token of [undefined,'old-launch','new-launch']){
  const req={headers:{host:'127.0.0.1:4000',...(token&&{'x-clideck-launch':token})}};
  const res={writeHead(){return this;},end(){}};
  await handleLegacyHook(server,req,res,'start',async()=>({clideck_id:'pane',session_id:'00000000-0000-0000-0000-000000000001'}));
 }
 assert.equal(calls,1);
 assert.equal(grokProvider.interruptInput,'\x03');
});

test('custom Grok rules merge once with integration rules and session flags',t=>{
 const root=mkdtempSync(join(tmpdir(),'grok-rules-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const provider=createCustomCommandProvider({providerId:'grok',command:'grok --rules "User project rules" --sandbox off'});
 const launch=provider.createLaunch({port:1234,grokConfigRoot:root,agentGuide:'Integration guide',extraArgs:['--rules=Session rules','--permission-mode','bypassPermissions']});
 assert.deepEqual(launch.extraArgs,[]);
 assert.equal(launch.nativeScroll,false);
 assert.equal(provider.createLaunch({port:1234,grokConfigRoot:root,extraArgs:['--minimal']}).nativeScroll,true);
 assert.equal(launch.args.filter(arg=>arg==='--rules').length,1);
 assert.equal(launch.args[launch.args.indexOf('--rules')+1],'User project rules\n\nSession rules\n\nIntegration guide');
 assert.deepEqual(launch.args.slice(0,4),['--sandbox','off','--permission-mode','bypassPermissions']);
});
