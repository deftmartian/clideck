const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { WorkerManager, parseSpawn, canAskSession } = require('../../src/fork-workers');
const { AskCoordinator } = require('../../src/ask');

function fixture({ answer = true, ready = true } = {}) {
  let counter = 0;
  const caller = { id:'parent', name:'Parent', cwd:'/tmp', provider:{id:'claude-code',supportsAsk:true}, cols:80, rows:24, closed:false, menu:[], status:'idle' };
  const records = [{...caller, provider:'claude-code'}];
  const sessions = new Map([['parent',caller]]);
  const server = { sessions, persistence:{dataDir:'/tmp',list:()=>records},
    configStore:{get:()=>({projects:[{id:'test',name:'Test',path:'/tmp'}]})},
    commands:{},providerLaunchOptions:()=>({}),findNameConflict:()=>false,
    askCoordinator:new AskCoordinator(), broadcastSessionError:()=>{},
    startSession(options) {
      const worker = new EventEmitter();
      Object.assign(worker,options,{id:`worker-${++counter}`,sessionStarted:ready,status:ready?'idle':null,menu:[],closed:false,turnOpen:false,prompts:[]});
      worker.sendPrompt = text => {worker.prompts.push(text);worker.turnOpen=true;if(answer)setImmediate(()=>{worker.turnOpen=false;worker.emit('event',{type:'agent.final',text:'FINISHED'});});return true;};
      worker.close = () => {worker.closed=true;worker.emit('event',{type:'session.closed'});};
      worker.waitForClose = async()=>{};
      records.push({...worker,provider:'claude-code'});sessions.set(worker.id,worker);return worker;
    },
  };
  return {server,manager:new WorkerManager(server),caller};
}
const request = {callerSessionId:'parent',project:'Test',name:'Worker',prompt:'Do a bounded task',wait:true,timeoutMs:1000};

test('spawn requires explicit project choice, rejects malformed prompts, and protects user sessions',()=>{
  assert.equal(parseSpawn({...request,project:undefined}),null);
  assert.equal(parseSpawn({...request,prompt:''}),null);
  assert.equal(parseSpawn({...request,timeoutMs:Infinity}),null);
  assert.equal(parseSpawn({...request,noProject:true}),null);
  assert.ok(parseSpawn({...request,project:undefined,noProject:true}));
  assert.equal(canAskSession({id:'parent'},{id:'peer'}),false);
  assert.equal(canAskSession({id:'parent'},{spawnedBySessionId:'parent'}),true);
  assert.equal(canAskSession({id:'other'},{spawnedBySessionId:'parent'}),false);
  assert.equal(canAskSession({id:'parent'},{id:'peer'},true),true);
});

test('waiting worker returns its first answer and closes without retaining an empty pane',async()=>{
  const {manager,server}=fixture();
  const result=await manager.spawn(request);
  assert.equal(result.answer,'FINISHED');
  const worker=server.sessions.get(result.sessionId);
  assert.equal(worker.spawnedBySessionId,'parent');
  assert.equal(worker.prompts.length,1);
  assert.equal(worker.closed,true);
  assert.equal(worker.removePersistenceOnClose,true);
  assert.equal(server.askCoordinator.isActive(worker.id),false);
});

test('unready workers receive no prompt and timed-out workers close and release the ask',async()=>{
  const unready=fixture({ready:false});
  const result=await unready.manager.spawn({...request,timeoutMs:20});
  assert.equal(result.error,'worker_not_ready');
  assert.deepEqual(unready.server.sessions.get(result.sessionId).prompts,[]);
  assert.equal(unready.server.sessions.get(result.sessionId).closed,true);
  const timeout=fixture({answer:false});
  const expired=await timeout.manager.spawn({...request,timeoutMs:20});
  assert.equal(expired.error,'timeout');
  assert.equal(timeout.server.sessions.get(expired.sessionId).closed,true);
  assert.equal(timeout.server.askCoordinator.isActive(expired.sessionId),false);
});

test('server limits visible workers to three and refuses recursive spawning',async()=>{
  const {manager,server}=fixture();
  const workers=await Promise.all([1,2,3].map(n=>manager.spawn({...request,name:`Worker ${n}`,wait:false})));
  assert.ok(workers.every(r=>r.ok));
  assert.equal((await manager.spawn({...request,wait:false})).error,'worker_limit');
  assert.equal((await manager.spawn({...request,callerSessionId:workers[0].sessionId})).error,'recursive_spawn_forbidden');
  for (const result of workers)server.sessions.get(result.sessionId).close();
});

 test('workers retain the caller custom launcher identity for later resume',async()=>{
  const {manager,server,caller}=fixture();
  caller.command='codex --dangerously-bypass-approvals-and-sandbox';
  Object.assign(server.persistence.list()[0],{commandId:'codex-yolo',commandLabel:'Codex Yolo'});
  const result=await manager.spawn({...request,wait:false});
  const worker=server.sessions.get(result.sessionId);
  assert.equal(worker.command,caller.command);
  assert.equal(worker.commandId,'codex-yolo');
  assert.equal(worker.commandLabel,'Codex Yolo');
  worker.close();
});
