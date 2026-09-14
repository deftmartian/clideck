const test=require('node:test');
const assert=require('node:assert/strict');
const {floatAudio,pcmToWav}=require('../../plugins/voice-input/backend');
const voice=require('../../plugins/voice-input/server');

test('voice PCM conversion preserves signed samples and ten-minute bound',()=>{
 const raw=Buffer.alloc(6);raw.writeInt16LE(-32768,0);raw.writeInt16LE(0,2);raw.writeInt16LE(16384,4);
 const converted=Buffer.from(floatAudio(raw),'base64');
 assert.deepEqual([0,4,8].map(i=>converted.readFloatLE(i)),[-1,0,.5]);
 assert.equal(voice.MAX_BYTES,16000*2*600);
});

test('voice plugin binds audio to a session, rejects overlapping records and discards cancelled results',async t=>{
 let finish,signal;const calls=[];const backend={ready:async()=>{},transcribe:(audio,options)=>{calls.push(audio);signal=options.signal;return new Promise(resolve=>{finish=resolve;});}};
 const handlers={},events=[],shutdown=[];
 voice.activate({dir:'/tmp',dataDir:'/tmp',getSetting:()=>'',getSession:async id=>({id,live:true}),onClientMessage:(name,fn)=>handlers[name]=fn,sendToClients:(event,data)=>events.push({event,data}),onShutdown:fn=>shutdown.push(fn),onSettingsChange:()=>{},log:()=>{}},{backend});
 t.after(()=>shutdown.forEach(fn=>fn()));
 const record={streamId:'record0001',sessionId:'session'};
 await handlers.prepare(record,{});
 await handlers.prepare({...record,streamId:'record0002'},{});
 assert.match(events.at(-1).data.body,/Another recording/);
 const audio=Buffer.alloc(12800).toString('base64');
 handlers.audio({...record,audio});
 const pending=handlers.finish(record);assert.equal(calls.length,1);
 handlers.cancel(record);assert.equal(signal.aborted,true);finish({text:'Should not be pasted'});await pending;
 assert.equal(events.some(e=>e.event==='transcript'),false);
 await handlers.prepare({...record,streamId:'record0003'},{});
 assert.equal(events.at(-1).data.state,'ready');
});

test('WAV preserves PCM16 samples without a float round trip',()=>{const pcm=Buffer.from([0,128,255,127,0,0]);const wav=pcmToWav(pcm);assert.equal(wav.readUInt32LE(40),pcm.length);assert.deepEqual(wav.subarray(44),pcm);});

test('native OpenAI backend sends PCM as WAV and propagates cancellation',async t=>{
 const {createTranscriber}=require('../../plugins/voice-input/backend');
 const settings={backend:'openai','openai-api-key':'test-only',language:'en'};
 const shutdown=[];const backend=createTranscriber({dir:'/tmp',dataDir:'/tmp',getSetting:key=>settings[key],onSettingsChange:()=>{},onShutdown:fn=>shutdown.push(fn),log:()=>{}});
 t.after(()=>shutdown.forEach(fn=>fn()));
 const raw=Buffer.alloc(16000);const controller=new AbortController();
 const fetchMock=t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(options.body.get('model'),'whisper-1');
  assert.equal(options.body.get('language'),'en');
  assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()).subarray(44),raw);
  return Response.json({text:'A recorded sentence.',language:'en'});
 });
 assert.equal((await backend.transcribe(raw,{signal:controller.signal})).text,'A recorded sentence.');
 fetchMock.mock.restore();controller.abort();
 await assert.rejects(backend.transcribe(raw,{signal:controller.signal}),/abort/i);
});

test('transcription preserves valid words and applies only explicit replacements',async t=>{
 const {mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),{join}=require('node:path');
 const dir=mkdtempSync(join(tmpdir(),'voice-words-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const rules=join(dir,'replacements.txt');writeFileSync(rules,'clidek => CliDeck | all\n');
 const settings={backend:'openai','openai-api-key':'test','replacements-file':rules};
 let words='';t.mock.method(globalThis,'fetch',async()=>Response.json({text:words}));
 const backend=require('../../plugins/voice-input/backend').createTranscriber({dir,dataDir:dir,getSetting:k=>settings[k],onSettingsChange:()=>{},onShutdown:fn=>t.after(fn),log:()=>{}});
 for(const text of ['you','Thank you.','Please keep this. Thank you!','cough','hmm','Продолжение следует...']){
  words=text;assert.equal((await backend.transcribe(Buffer.alloc(2))).text,text);
 }
 words='Use clidek. Thank you.';assert.equal((await backend.transcribe(Buffer.alloc(2))).text,'Use CliDeck. Thank you.');
});

test('missing local voice setup fails without creating or installing an environment',async t=>{
 const {mkdtempSync,existsSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),{join}=require('node:path');
 const dir=mkdtempSync(join(tmpdir(),'voice-unprepared-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const backend=require('../../plugins/voice-input/backend').createTranscriber({dir,dataDir:dir,getSetting:k=>k==='backend'?'local':'',onSettingsChange:()=>{},onShutdown:fn=>t.after(fn),log:()=>{}});
 await assert.rejects(backend.ready(),/clideck-voice-setup/);assert.equal(existsSync(join(dir,'.venv')),false);
});
