import assert from 'node:assert/strict';
import {configureTerminalStream,subscribeTerminal,handleTerminalFrame,disconnectTerminalStream,resetTerminalStream} from '../public/js/terminal-stream.js';
globalThis.document={visibilityState:'visible'};
const sent=[],parsed=[];
const session={id:'A',live:true,outputBuf:''};
const store={connected:true,activeId:'A',active:()=>session,applyEvent:event=>parsed.push(event.parsed)};
const term={cols:80,rows:24,write:(_,callback)=>callback?.(),reset:()=>{}};
configureTerminalStream({store,term,send:message=>sent.push(message)});
subscribeTerminal();
assert.equal(sent.at(-1).claimResize,true,'visible selection owns the PTY dimensions');
assert.equal(sent.at(-1).strategy,'auto','reconnect uses the cursor protocol');
handleTerminalFrame({type:'session.sync',id:'A',streamId:1,generation:'one',mode:'snapshot',targetSeq:5});
handleTerminalFrame({type:'session.snapshot',id:'A',streamId:1,generation:'one',atSeq:5,part:0,parts:1,data:'hello'});
assert.equal(sent.some(message=>message.type==='session.ack'),false);
parsed.shift()();
assert.equal(sent.at(-1).type,'session.ack');
subscribeTerminal();assert.deepEqual(sent.at(-1).cursor,{generation:'one',seq:5});
handleTerminalFrame({type:'session.sync',id:'A',streamId:1,generation:'one',mode:'current',targetSeq:5});
handleTerminalFrame({type:'output',id:'A',streamId:1,generation:'one',startSeq:5,endSeq:9,data:'more'});
disconnectTerminalStream();
const before=sent.length;parsed.shift()();assert.equal(sent.length,before,'a stale parser callback cannot ACK a disconnected stream');
subscribeTerminal();assert.equal(sent.at(-1).cursor,undefined,'unparsed output forces a fresh snapshot on reconnect');
resetTerminalStream();
console.log('PASS: ACK follows parsing; disconnect invalidates unfinished output without stale ACKs');

// Use real xterm parsing: an old queued write must drain BEFORE the snapshot reset.
const {createRequire}=await import('node:module');
const {Terminal}=createRequire(import.meta.url)('@xterm/headless');
const terminal=new Terminal({cols:80,rows:24,allowProposedApi:true});
try {
 const state={id:'queued',live:true,outputBuf:''};
 configureTerminalStream({term:terminal,send:()=>{},store:{connected:true,activeId:'queued',active:()=>state,applyEvent:event=>terminal.write(event.data,event.parsed)}});
 terminal.write('\x1b[24;1H> OLD');
 handleTerminalFrame({type:'session.sync',id:'queued',streamId:2,generation:'new',mode:'snapshot',targetSeq:10});
 handleTerminalFrame({type:'session.snapshot',id:'queued',streamId:2,generation:'new',atSeq:10,part:0,parts:1,data:'OUTPUT HISTORY\x1b[24;1H> CURSOR'});
 await new Promise(resolve=>terminal.write('',resolve));
 const buffer=terminal.buffer.active;
 assert.equal(buffer.getLine(buffer.baseY).translateToString(true),'OUTPUT HISTORY');
 assert.equal(buffer.getLine(buffer.baseY+23).translateToString(true),'> CURSOR');
 console.log('PASS: queued output cannot cross the snapshot reset boundary');
} finally {resetTerminalStream();terminal.dispose();}

const oldReset=new Terminal({cols:80,rows:24,allowProposedApi:true});
try {
 oldReset.write('\x1b[24;1H> OLD');oldReset.reset();
 await new Promise(resolve=>oldReset.write('OUTPUT HISTORY\x1b[24;1H> CURSOR',resolve));
 assert.notEqual(oldReset.buffer.active.getLine(oldReset.buffer.active.baseY).translateToString(true),'OUTPUT HISTORY','negative control reproduces the old synchronous reset corruption');
} finally {oldReset.dispose();}
