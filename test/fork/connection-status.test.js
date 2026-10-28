const test=require('node:test');
const assert=require('node:assert/strict');
test('connection diagnosis distinguishes sign-in, server failures and incompatible clients',async t=>{
 const {diagnoseConnection}=await import('../../public/js/connection-status.js');
 for(const [response,expected] of [[new Response('',{status:401}),'auth'],[new Response('',{status:503}),'unavailable'],[new Response('<html>sign in</html>',{headers:{'content-type':'text/html'}}),'auth'],[Response.json({protocol:'fork-v5'}),'incompatible'],[Response.json({protocol:'fork-v6'}),'unavailable']]) {
  const mock=t.mock.method(globalThis,'fetch',async()=>response);
  assert.equal(await diagnoseConnection(new AbortController().signal),expected);mock.mock.restore();
 }
});
