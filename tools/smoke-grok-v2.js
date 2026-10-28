const { mkdtempSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir, homedir } = require('os');
const { HeadlessServer } = require('../src/server');
const hooks = require('../src/fork/grok-hooks');

(async () => {
  if (!hooks.hasAny(join(homedir(), '.grok'))) throw new Error('Existing Grok hooks required; this smoke does not install or modify global hooks.');
  const dir = mkdtempSync(join(tmpdir(), 'clideck-grok-v2-smoke-'));
  const server = new HeadlessServer({ port:0, dataDir:dir, cwd:dir });
  try {
    await server.listen();
    const session = server.createSession({provider:'grok',cwd:dir,name:'Isolated Grok smoke'});
    const ready = await new Promise(resolve => {
      const timer=setTimeout(()=>finish(false),45000);
      const poll=setInterval(()=>{if(session.closed)finish(false);else if(session.sessionStarted&&session.status==='idle')finish(true);},100);
      const finish=value=>{clearTimeout(timer);clearInterval(poll);resolve(value);};
    });
    if (!ready) console.error((await session.capture.lines({limit:16})).join('\n').replace(/https?:\/\/\S+/g,'[URL]'));
    if (!ready) throw new Error(`Grok did not become ready (closed=${session.closed}, started=${session.sessionStarted}, status=${session.status}).`);
    const answer=await server.askCoordinator.ask(session,'Create a small self-contained HTML report named grok-parity.html in the current directory with heading CLIDECK_GROK_V2_OK. Use the preview command described in your CliDeck session instructions to open it as a report tab. Do not contact other sessions or use the network. Then reply with exactly CLIDECK_GROK_V2_OK.',90000);
    if(!answer.ok || !answer.answer.includes('CLIDECK_GROK_V2_OK'))throw new Error(`Native Grok response failed: ${JSON.stringify(answer)}`);
    const previews = await server.contentStore.replay(session.id);
    if (!previews.events.some(event=>event.kind==='html')) throw new Error('Grok did not publish its HTML preview through the shared CLI.');
    const telemetryDeadline=Date.now()+10000;
    while (Date.now()<telemetryDeadline && (!session.model || !session.contextUsage)) await new Promise(resolve=>setTimeout(resolve,100));
    if (!session.model || !session.contextUsage?.windowTokens) throw new Error('Native Grok model/context telemetry missing.');
    console.log(`Native telemetry: ${session.model}, ${session.contextUsage.usedTokens}/${session.contextUsage.windowTokens}`);
    const handle = server.persistence.get(session.id).resumeHandle;
    if (!handle) throw new Error('Grok resume handle was not persisted.');
    const resumed = await server.restartSession({sessionId:session.id,cols:120,rows:40,touchUi:true});
    if (!resumed || resumed.launchOptions.resumeHandle !== handle || !resumed.launchOptions.touchUi) throw new Error('Grok restart lost its resume handle or mobile policy.');
    const deadline = Date.now() + 45000;
    while (!resumed.closed && Date.now() < deadline && !(resumed.sessionStarted && resumed.status === 'idle')) await new Promise(resolve => setTimeout(resolve,100));
    if (resumed.status !== 'idle') throw new Error('Resumed Grok did not become ready.');
    if (!(await server.contentStore.replay(resumed.id)).events.some(event=>event.kind==='html')) throw new Error('Grok preview lost across restart.');
    const continuation = await server.askCoordinator.ask(resumed,'What exact marker did you just reply with? Repeat only that marker. Do not use tools.',45000);
    if (!continuation.ok || !continuation.answer.includes('CLIDECK_GROK_V2_OK')) {
      console.error('Resume reply result:', JSON.stringify(continuation));
      console.error((await resumed.capture.lines({limit:20})).join('\n').replace(/https?:\/\/\S+/g,'[URL]'));
      throw new Error('Grok resume reply verification failed.');
    }
    console.log('PASS: native Grok launch, hooks, canonical reply, HTML report, model/context telemetry, Ask, mobile restart and conversation resume');
  } finally {await server.close();rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
