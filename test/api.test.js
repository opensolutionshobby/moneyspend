import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/* the roster-cap test alone fires 50 writes; the throttle is exercised separately */
process.env.LEVEL_RATE_LIMIT = 'off';

import { openDb } from '../server/db.js';
import { createServer } from '../server.js';
import { closeAll } from '../server/sse.js';

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'level-')), 'test.db');
const store = openDb(dbFile);
const server = createServer(store);
await new Promise(res => server.listen(0, '127.0.0.1', res));
const base = 'http://127.0.0.1:' + server.address().port;

test.after(() => { closeAll(); server.close(); store.close(); });

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const newEvent = async (name = 'TEST NIGHT') => (await api('POST', '/api/events', { name })).body;

test('create → add people → add items → totals', async () => {
  const ev = await newEvent('FRIDAY THREE');
  assert.match(ev.id, /^[a-z2-9]{10}$/);
  assert.equal(ev.name, 'FRIDAY THREE');
  assert.deepEqual(ev.people, []);

  const a = (await api('POST', `/api/events/${ev.id}/people`, { name: 'Mara' })).body;
  assert.equal(a.people.length, 1);
  const mara = a.people[0].id;
  const b = (await api('POST', `/api/events/${ev.id}/people`, { name: 'Jonas' })).body;
  const jonas = b.people[1].id;

  await api('POST', `/api/events/${ev.id}/people/${mara}/items`, { label: 'Dinner', amountCents: 8400 });
  await api('POST', `/api/events/${ev.id}/people/${mara}/items`, { label: 'Taxi', amountCents: 1200 });
  const after = (await api('POST', `/api/events/${ev.id}/people/${jonas}/items`, { label: 'Beers', amountCents: 2150 })).body;

  assert.equal(after.people[0].items[0].qty, 1, 'quantity defaults to one');
  assert.equal(after.people[0].totalCents, 9600);
  assert.equal(after.people[1].totalCents, 2150);
  assert.equal(after.totalCents, 11750);
  assert.ok(after.rev > ev.rev, 'rev advances on every mutation');
});

test('quantity multiplies the unit amount', async () => {
  const ev = await newEvent();
  const p = (await api('POST', `/api/events/${ev.id}/people`, { name: 'Mara' })).body.people[0].id;

  /* 3 tickets at 5000 each */
  const added = (await api('POST', `/api/events/${ev.id}/people/${p}/items`,
    { label: 'Tickets', amountCents: 500000, qty: 3 })).body;
  const item = added.people[0].items[0];
  assert.equal(item.amountCents, 500000, 'the stored amount stays per unit');
  assert.equal(item.qty, 3);
  assert.equal(item.totalCents, 1500000);
  assert.equal(added.people[0].totalCents, 1500000);
  assert.equal(added.totalCents, 1500000);

  const requantified = (await api('PATCH', `/api/events/${ev.id}/items/${item.id}`, { qty: 5 })).body;
  assert.equal(requantified.people[0].totalCents, 2500000);

  for (const q of [0, -2, 1.5, 1000, '3', null]) {
    const { status } = await api('PATCH', `/api/events/${ev.id}/items/${item.id}`, { qty: q });
    assert.equal(status, 400, `qty ${q} must be rejected`);
  }
});

test('editing and deleting an entry', async () => {
  const ev = await newEvent();
  const p = (await api('POST', `/api/events/${ev.id}/people`, { name: 'Priya' })).body.people[0].id;
  const item = (await api('POST', `/api/events/${ev.id}/people/${p}/items`, { label: 'x', amountCents: 100 }))
    .body.people[0].items[0].id;

  const edited = (await api('PATCH', `/api/events/${ev.id}/items/${item}`, { label: 'Cinema', amountCents: 3610 })).body;
  assert.equal(edited.people[0].items[0].label, 'Cinema');
  assert.equal(edited.people[0].totalCents, 3610);

  const removed = (await api('DELETE', `/api/events/${ev.id}/items/${item}`)).body;
  assert.equal(removed.people[0].items.length, 0);
  assert.equal(removed.people[0].totalCents, 0);
});

test('removing a person takes their entries with them', async () => {
  const ev = await newEvent();
  const p = (await api('POST', `/api/events/${ev.id}/people`, { name: 'Tom' })).body.people[0].id;
  await api('POST', `/api/events/${ev.id}/people/${p}/items`, { label: 'Ski pass', amountCents: 12000 });
  const gone = (await api('DELETE', `/api/events/${ev.id}/people/${p}`)).body;
  assert.deepEqual(gone.people, []);
  assert.equal(gone.totalCents, 0);
  assert.equal(store.itemCount(ev.id), 0, 'items cascade with the person');
});

test('rename and settle', async () => {
  const ev = await newEvent('OLD');
  const named = (await api('PATCH', `/api/events/${ev.id}`, { name: 'SKI TRIP' })).body;
  assert.equal(named.name, 'SKI TRIP');
  const settled = (await api('PATCH', `/api/events/${ev.id}`, { settled: true })).body;
  assert.ok(settled.settledAt > 0);
  const unsettled = (await api('PATCH', `/api/events/${ev.id}`, { settled: false })).body;
  assert.equal(unsettled.settledAt, null);
});

test('summaries feed the recent rail', async () => {
  const one = await newEvent('ONE');
  const two = await newEvent('TWO');
  const p = (await api('POST', `/api/events/${one.id}/people`, { name: 'A' })).body.people[0].id;
  await api('POST', `/api/events/${one.id}/people/${p}/items`, { amountCents: 5000 });

  const { body } = await api('GET', `/api/events?ids=${one.id},${two.id},nosuchid`);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].totalCents, 5000);
  assert.equal(body.events[0].people, 1);
  assert.ok(!('items' in body.events[0]), 'summaries stay thin');
});

test('bad input is refused, never 500', async () => {
  const ev = await newEvent();
  const p = (await api('POST', `/api/events/${ev.id}/people`, { name: 'A' })).body.people[0].id;
  const url = `/api/events/${ev.id}/people/${p}/items`;

  for (const amountCents of [12.5, -1, 1_000_000_01, '100', null]) {
    const { status } = await api('POST', url, { amountCents });
    assert.equal(status, 400, `amountCents ${amountCents} must be rejected`);
  }
  assert.equal((await api('POST', url, { label: 'x'.repeat(81), amountCents: 1 })).status, 400);
  assert.equal((await api('POST', `/api/events/${ev.id}/people`, { name: 'y'.repeat(61) })).status, 400);
  assert.equal((await api('PATCH', `/api/events/${ev.id}`, {})).status, 400);
  assert.equal((await api('PATCH', `/api/events/${ev.id}`, { settled: 'yes' })).status, 400);
});

test('unknown ids are 404', async () => {
  const ev = await newEvent();
  assert.equal((await api('GET', '/api/events/nosuchevent')).status, 404);
  assert.equal((await api('PATCH', `/api/events/${ev.id}/people/nosuchperson`, { name: 'x' })).status, 404);
  assert.equal((await api('DELETE', `/api/events/${ev.id}/items/nosuchitem`)).status, 404);
  assert.equal((await api('PUT', `/api/events/${ev.id}`, {})).status, 405);
});

test('the roster is capped', async () => {
  const ev = await newEvent();
  for (let i = 0; i < 50; i++) {
    const { status } = await api('POST', `/api/events/${ev.id}/people`, { name: 'P' + i });
    assert.equal(status, 201);
  }
  const over = await api('POST', `/api/events/${ev.id}/people`, { name: 'one too many' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /50 people/);
});

test('SSE pushes every change to every listener', async () => {
  const ev = await newEvent('LIVE');

  const listeners = await Promise.all([0, 1].map(async () => {
    const res = await fetch(`${base}/api/events/${ev.id}/stream`);
    assert.equal(res.status, 200);
    return res.body.getReader();
  }));

  const decoder = new TextDecoder();
  /** Read frames until one satisfies `want`, or time out. */
  const until = async (reader, want) => {
    let buf = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const frame of buf.split('\n\n')) {
        const line = frame.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (want(payload)) return payload;
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
    throw new Error('no matching SSE frame arrived');
  };

  await api('POST', `/api/events/${ev.id}/people`, { name: 'Ines' });

  const seen = await Promise.all(listeners.map(r => until(r, e => e.people.some(p => p.name === 'Ines'))));
  for (const payload of seen) {
    assert.equal(payload.id, ev.id);
    assert.equal(payload.people.length, 1);
  }
  for (const r of listeners) await r.cancel();
});

test('the write throttle eventually says no', async () => {
  process.env.LEVEL_RATE_LIMIT = 'on';
  try {
    const ev = await newEvent();
    let sawThrottle = false;
    for (let i = 0; i < 200 && !sawThrottle; i++) {
      const { status } = await api('PATCH', `/api/events/${ev.id}`, { name: 'N' + i });
      sawThrottle = status === 429;
    }
    assert.ok(sawThrottle, 'a write flood is throttled');
    /* reads stay available while writes are throttled */
    assert.equal((await api('GET', `/api/events/${ev.id}`)).status, 200);
  } finally {
    process.env.LEVEL_RATE_LIMIT = 'off';
  }
});

test('static routes serve the app shell', async () => {
  const ev = await newEvent();
  const page = await fetch(`${base}/e/${ev.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div class="app">/);

  assert.equal((await fetch(`${base}/`)).status, 200);
  const recent = await fetch(`${base}/recent`);
  assert.equal(recent.status, 200);
  assert.match(await recent.text(), /recent\.js/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  assert.equal((await fetch(`${base}/nope.css`)).status, 404);
});
