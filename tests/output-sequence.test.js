const test = require('node:test');
const assert = require('node:assert/strict');
const { Sandbox } = require('./providers/sandbox');
const { Client } = require('./providers/client');

test('live output and reconnect replay carry continuous sequence metadata', async t => {
  const box = new Sandbox();
  const first = new Client();
  const second = new Client();
  const third = new Client();
  t.after(async () => {
    first.close();
    second.close();
    third.close();
    await box.cleanup();
  });

  const port = await box.start();
  first.port = port;
  second.port = port;
  await first.connect();
  await first.waitFor('config');
  const commandId = first.commandIdFor('shell');
  assert.ok(commandId);

  first.send({
    type: 'create',
    commandId,
    name: 'sequence-test',
    cwd: box.workDir('sequence-test'),
    cols: 80,
    rows: 24,
  });
  const created = await first.waitFor('created');
  await first.waitFor(
    msg => msg.type === 'session.subscribed' && msg.id === created.id,
    { label: 'initial session subscription' },
  );
  const liveMarker = `SEQUENCE_LIVE_${Date.now()}`;
  first.send({ type: 'input', id: created.id, data: `printf '${liveMarker}\\n'\r` });
  const live = await first.waitFor(
    msg => msg.type === 'output' && msg.id === created.id && String(msg.data).includes(liveMarker),
    { label: 'sequenced live output' },
  );
  assert.match(live.generation, /^[0-9a-f-]{36}$/i);
  assert.equal(live.endSeq - live.startSeq, live.data.length);

  await second.connect();
  const replay = await second.waitFor(
    msg => msg.type === 'session.snapshot' && msg.id === created.id,
    { label: 'sequenced reconnect snapshot' },
  );
  assert.equal(replay.generation, live.generation);
  assert.ok(replay.atSeq >= live.endSeq);

  const overflowMarker = `BUFFER_DONE_${Date.now()}`;
  first.send({
    type: 'input',
    id: created.id,
    data: `node -e "process.stdout.write('X'.repeat(2200000)); process.stdout.write('\\n${overflowMarker}\\n')"\r`,
  });
  await first.waitFor(
    msg => msg.type === 'output'
      && msg.id === created.id
      && (first.output.get(created.id) || '').length > 2200000,
    { label: 'complete oversized output' },
  );

  third.port = port;
  await third.connect();
  const boundedReplay = await third.waitFor(
    msg => msg.type === 'session.snapshot' && msg.id === created.id,
    { label: 'bounded reconnect snapshot' },
  );
  assert.ok(Buffer.byteLength(boundedReplay.data) <= 1024 * 1024);
  assert.ok(boundedReplay.atSeq > 0, 'snapshot must be associated with processed output');
});
