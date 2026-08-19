const test = require('node:test');
const assert = require('node:assert/strict');
const { Sandbox } = require('./providers/sandbox');
const { Client } = require('./providers/client');

async function settle(ms = 80) { await new Promise(resolve => setTimeout(resolve, ms)); }

async function createShell(client, box, name) {
  client.send({
    type: 'create', commandId: client.commandIdFor('shell'), name,
    cwd: box.workDir(name), cols: 80, rows: 24,
  });
  return client.waitFor(msg => msg.type === 'created' && msg.name === name);
}

test('connection is control-only until one session is subscribed', async t => {
  const box = new Sandbox();
  const owner = new Client();
  const idle = new Client();
  owner.autoSubscribe = false;
  idle.autoSubscribe = false;
  t.after(async () => { owner.close(); idle.close(); await box.cleanup(); });
  const port = await box.start();
  owner.port = idle.port = port;
  await owner.connect();
  await owner.waitFor('config');
  const created = await createShell(owner, box, 'control-only');
  owner.send({ type: 'input', id: created.id, data: "printf 'CONTROL_ONLY_MARK\\n'\r" });
  await settle();

  await idle.connect();
  await idle.waitFor('pills');
  await settle();
  assert.equal(idle.accounting.snapshotReplayBytes, 0);
  assert.equal(idle.messages.some(message => message.type === 'output' || message.type === 'session.snapshot'), false);
  assert.ok(idle.accounting.initialControlBytes <= 50 * 1024, idle.accounting.initialControlBytes);
  assert.equal(idle.messages.some(message => message.type === 'transcript.cache'), false);
  idle.send({ type: 'transcript.cache.request' });
  assert.ok(await idle.waitFor('transcript.cache'));
});

test('active-session subscriptions isolate output and broadcast it to multiple active viewers', async t => {
  const box = new Sandbox();
  const producer = new Client();
  const first = new Client();
  const second = new Client();
  const same = new Client();
  for (const client of [producer, first, second, same]) client.autoSubscribe = false;
  t.after(async () => {
    for (const client of [producer, first, second, same]) client.close();
    await box.cleanup();
  });
  const port = await box.start();
  for (const client of [producer, first, second, same]) client.port = port;
  await producer.connect(); await producer.waitFor('config');
  const a = await createShell(producer, box, 'stream-a');
  const b = await createShell(producer, box, 'stream-b');
  for (const client of [first, second, same]) { await client.connect(); await client.waitFor('config'); }
  first.subscribe(a.id, { replay: 'snapshot' });
  second.subscribe(b.id, { replay: 'snapshot' });
  same.subscribe(a.id, { replay: 'snapshot' });
  await Promise.all([
    first.waitFor(msg => msg.type === 'session.subscribed' && msg.id === a.id),
    second.waitFor(msg => msg.type === 'session.subscribed' && msg.id === b.id),
    same.waitFor(msg => msg.type === 'session.subscribed' && msg.id === a.id),
  ]);
  for (const client of [first, second, same]) { client.messages.length = 0; client.resetAccounting(); }

  producer.send({ type: 'input', id: a.id, data: "printf 'ONLY_A\\n'\r" });
  producer.send({ type: 'input', id: b.id, data: "printf 'ONLY_B\\n'\r" });
  await first.waitFor(msg => msg.type === 'output' && msg.data.includes('ONLY_A'));
  await second.waitFor(msg => msg.type === 'output' && msg.data.includes('ONLY_B'));
  await same.waitFor(msg => msg.type === 'output' && msg.data.includes('ONLY_A'));
  await settle();

  assert.equal(first.messages.some(msg => msg.type === 'output' && msg.id === b.id), false);
  assert.equal(second.messages.some(msg => msg.type === 'output' && msg.id === a.id), false);
  assert.equal(same.messages.some(msg => msg.type === 'output' && msg.id === b.id), false);
});

test('last interaction owns PTY dimensions and resize messages alone cannot claim them', async t => {
  const box = new Sandbox();
  const producer = new Client();
  const one = new Client();
  const two = new Client();
  const observer = new Client();
  for (const client of [producer, one, two, observer]) client.autoSubscribe = false;
  t.after(async () => {
    for (const client of [producer, one, two, observer]) client.close();
    await box.cleanup();
  });
  const port = await box.start();
  for (const client of [producer, one, two, observer]) client.port = port;
  await producer.connect(); await producer.waitFor('config');
  const created = await createShell(producer, box, 'resize-owner');
  for (const client of [one, two, observer]) { await client.connect(); await client.waitFor('config'); }
  one.subscribe(created.id, { replay: 'snapshot', claimResize: true, cols: 100, rows: 30 });
  await one.waitFor('session.subscribed');
  two.subscribe(created.id, { replay: 'snapshot', claimResize: true, cols: 110, rows: 31 });
  await two.waitFor('session.subscribed');
  one.send({ type: 'resize', id: created.id, cols: 120, rows: 32 });
  two.send({ type: 'resize', id: created.id, cols: 121, rows: 33 });
  observer.send({ type: 'resize', id: created.id, cols: 130, rows: 40 });
  await settle();
  observer.subscribe(created.id, { replay: 'snapshot' });
  const snapshot = await observer.waitFor(msg => msg.type === 'session.snapshot' && msg.id === created.id);
  assert.deepEqual([snapshot.cols, snapshot.rows], [121, 33]);
});
