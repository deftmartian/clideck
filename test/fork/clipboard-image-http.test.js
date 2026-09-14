const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, statSync, readdirSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { HeadlessServer } = require('../../src/server');
const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

test('image HTTP upload validates origin, protocol and magic without inserting into a terminal', async () => {
  const dataDir=mkdtempSync(join(tmpdir(),'clideck-image-v2-'));
  const server=new HeadlessServer({port:0,dataDir,cwd:dataDir});
  try {
    const {httpUrl}=await server.listen();
    const session=server.createSession({provider:'shell',cwd:dataDir});
    const pasted=[];session.writeInput=data=>pasted.push(data);
    const url=`${httpUrl}/api/session/${session.id}/clipboard-image`;
    const send=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'image/png','X-Clideck-Protocol':'fork-v6',...headers},body});
    assert.equal((await send(PNG,{Origin:'https://hostile.example'})).status,403);
    assert.equal((await send(PNG,{'X-Clideck-Protocol':'old'})).status,409);
    assert.equal((await send(Buffer.from('not an image'))).status,415);
    assert.deepEqual(pasted,[]);
    const response=await send(PNG);assert.equal(response.status,201);
    const result=await response.json();assert.equal(statSync(result.path).mode&0o777,0o600);
    assert.deepEqual(pasted,[]);
    assert.equal(readdirSync(join(dataDir,'uploads','images')).length,1);
  } finally {await server.close();rmSync(dataDir,{recursive:true,force:true});}
});
