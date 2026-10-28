const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server');
const { getProvider } = require('../../src/providers');

test('fork reconnect reads no terminal histories until a dormant session is selected', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-history-check-'));
  const server = new HeadlessServer({port:0, dataDir, cwd:dataDir});
  try {
    await server.listen();
    server.persistence.register({id:'dormant', provider:getProvider('shell'), cwd:dataDir, cols:80, rows:24});
    server.persistence.appendHistory('dormant', 'SAVED HISTORY\r\n');
    server.persistence.flushHistory('dormant');
    const original = server.persistence.historyTail.bind(server.persistence);
    let reads = 0;
    server.persistence.historyTail = id => { reads++; return original(id); };
    const frames=[];
    const socket = {forkTransport:true, readyState:1, bufferedAmount:0, send:data=>frames.push(JSON.parse(data))};
    server.replayDormantSession(socket, server.persistence.get('dormant'));
    assert.equal(reads, 0);
    assert.ok(!frames.some(frame=>frame.type==='output'));
    await server.forkTransport.selectedHistory(socket, {sessionId:'dormant', requestId:'selected'});
    assert.equal(reads, 1);
    const reply = frames.find(frame=>frame.type==='session.history');
    assert.equal(reply.requestId, 'selected');
    assert.match(reply.data, /SAVED HISTORY/);
    assert.ok(Buffer.byteLength(reply.data) <= 1024*1024);
    reads = 0; frames.length = 0;
    // Legacy dimensions are normalized; rapid selection keeps only the latest queued capture.
    Object.assign(server.persistence.get('dormant'), {cols:900, rows:1});
    await Promise.all(['one','two','three'].map(requestId => server.forkTransport.selectedHistory(socket, {sessionId:'dormant',requestId})));
    assert.equal(reads, 2);
    assert.deepEqual(frames.filter(frame=>frame.type==='session.history').map(frame=>frame.requestId), ['three']);
  } finally { await server.close(); rmSync(dataDir, {recursive:true, force:true}); }
});
