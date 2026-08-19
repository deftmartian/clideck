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

test('inactive sessions broadcast activity without leaking terminal output', async t => {
  const box = new Sandbox();
  const producer = new Client();
  const viewer = new Client();
  producer.autoSubscribe = false;
  viewer.autoSubscribe = false;
  t.after(async () => { producer.close(); viewer.close(); await box.cleanup(); });
  const port = await box.start();
  producer.port = viewer.port = port;
  await producer.connect(); await producer.waitFor('config');
  const inactive = await createShell(producer, box, 'activity-inactive');
  const active = await createShell(producer, box, 'activity-active');
  await viewer.connect(); await viewer.waitFor('config');
  viewer.subscribe(active.id, { replay: 'snapshot' });
  await viewer.waitFor(msg => msg.type === 'session.subscribed' && msg.id === active.id);
  viewer.messages.length = 0;

  producer.send({ type: 'input', id: inactive.id, data: "printf 'INACTIVE_ACTIVITY_MARK\\n'\r" });
  const activity = await viewer.waitFor(
    msg => msg.type === 'session.activity' && msg.id === inactive.id,
    { label: 'inactive activity signal' },
  );
  await settle();

  assert.equal(typeof activity.timestamp, 'string');
  assert.match(activity.generation, /^[0-9a-f-]{36}$/i);
  assert.ok(Number.isSafeInteger(activity.atSeq) && activity.atSeq > 0);
  assert.equal(viewer.messages.some(msg => msg.type === 'output' && msg.id === inactive.id), false);
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

test('invalid create and restart sizes preserve the live session', async t => {
  const box = new Sandbox();
  const client = new Client();
  client.autoSubscribe = false;
  t.after(async () => { client.close(); await box.cleanup(); });
  client.port = await box.start();
  await client.connect(); await client.waitFor('config');
  client.send({
    type: 'create', commandId: client.commandIdFor('shell'), name: 'invalid-size',
    cwd: box.workDir('invalid-size'), cols: 19, rows: 24,
  });
  const createError = await client.waitFor(msg => msg.type === 'error' && /Terminal size/.test(msg.message));
  assert.match(createError.message, /20-500/);
  assert.equal(client.messages.some(msg => msg.type === 'created' && msg.name === 'invalid-size'), false);

  const created = await createShell(client, box, 'restart-size');
  client.subscribe(created.id, { replay: 'snapshot' });
  await client.waitFor(msg => msg.type === 'session.subscribed' && msg.id === created.id);
  client.send({ type: 'session.restart', id: created.id, cols: 80, rows: 301 });
  const rejected = await client.waitFor(
    msg => msg.type === 'session.restarted' && msg.id === created.id && msg.error,
  );
  assert.equal(rejected.retained, true);
  const marker = `RESTART_RETAINED_${Date.now()}`;
  client.send({ type: 'input', id: created.id, data: `printf '${marker}\\n'\r` });
  await client.waitFor(msg => msg.type === 'output' && msg.id === created.id && msg.data.includes(marker));
});

test('headless capture owns DSR and DA replies while browser replies are discarded', async t => {
  const box = new Sandbox();
  const client = new Client();
  client.autoSubscribe = false;
  t.after(async () => { client.close(); await box.cleanup(); });
  client.port = await box.start();
  await client.connect(); await client.waitFor('config');
  const created = await createShell(client, box, 'query-owner');
  client.subscribe(created.id, { replay: 'snapshot' });
  await client.waitFor(msg => msg.type === 'session.subscribed' && msg.id === created.id);
  const program = [
    'process.stdin.setRawMode(true)',
    "let s='',timer",
    "process.stdin.on('data',d=>{s+=d.toString('latin1');clearTimeout(timer);timer=setTimeout(()=>{const r=(s.match(/R/g)||[]).length,c=(s.match(/c/g)||[]).length;console.log('QUERY_COUNTS_'+r+'_'+c);process.exit(0)},200)})",
    "process.stdout.write('\\u001b[6n\\u001b[c')",
  ].join(';');
  client.send({ type: 'input', id: created.id, data: `node -e "${program}"\r` });
  await client.waitFor(
    msg => msg.type === 'output' && msg.id === created.id && msg.data.includes('\x1b[6n'),
    { label: 'terminal query output' },
  );
  client.send({ type: 'input', id: created.id, data: '\x1b[99;99R' });
  client.send({ type: 'input', id: created.id, data: '\x1b[>99c' });
  await client.waitFor(
    msg => msg.type === 'output' && msg.id === created.id
      && (client.output.get(created.id) || '').includes('QUERY_COUNTS_1_1'),
    { label: 'single headless terminal replies' },
  );
});
