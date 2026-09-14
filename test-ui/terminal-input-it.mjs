import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalInput} from '../public/js/ui/terminal-input.js';

test('input ownership survives session/offline changes and prevents focus stealing',()=>{
 let session={id:'one',live:true}, connected=true, focused=0, blurred=0;
 const attrs=new Map(), document={activeElement:null};
 const textarea={ownerDocument:document,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),blur:()=>{blurred++;document.activeElement=null;}};
 const term={options:{},textarea,focus:()=>{focused++;document.activeElement=textarea;}};
 const input=createTerminalInput({getTerminal:()=>term,getSession:()=>session,isConnected:()=>connected});
 input.sync();input.focus();assert.equal(focused,1);
 input.setOwner('composer');assert.equal(blurred,1);assert.equal(attrs.get('inputmode'),'none');assert.equal(term.options.disableStdin,true);
 session={id:'two',live:true};input.sync();input.focus();assert.equal(focused,1);assert.equal(textarea.disabled,true);
 input.setOwner('terminal');assert.equal(term.options.disableStdin,false);assert.equal(textarea.disabled,false);assert.equal(attrs.has('inputmode'),false);
 connected=false;input.sync();input.focus();assert.equal(focused,1);assert.equal(input.canWrite(),false);
 connected=true;input.setOwner('plugin');input.focus();assert.equal(focused,1);
 input.setOwner('terminal');input.focus();assert.equal(focused,2);
 session.live=false;input.sync();assert.equal(textarea.readOnly,true);assert.equal(input.canWrite(),false);
});
