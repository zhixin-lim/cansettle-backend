import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.mjs';
import { _resetAll } from './store/inMemoryStore.mjs';

process.env.STORE = 'memory';

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
});

after(() => server.close());
beforeEach(() => _resetAll());

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function patch(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

test('full flow: create session -> people -> bills -> allocate -> settle', async () => {
  const session = (await post('/sessions', { label: 'Dinner + Dessert' })).body;

  const sarah = (await post(`/sessions/${session.id}/participants`, { name: 'Sarah' })).body;
  const rachel = (await post(`/sessions/${session.id}/participants`, { name: 'Rachel' })).body;
  const hannah = (await post(`/sessions/${session.id}/participants`, { name: 'Hannah' })).body;

  const dinner = (
    await post(`/sessions/${session.id}/bills`, {
      source: 'manual',
      payerId: sarah.id,
      totalCents: 12000,
      items: [
        { name: 'Sarah items', totalCents: 5000 },
        { name: 'Rachel items', totalCents: 4000 },
        { name: 'Hannah items', totalCents: 3000 },
      ],
    })
  ).body;

  const dessert = (
    await post(`/sessions/${session.id}/bills`, {
      source: 'manual',
      payerId: hannah.id,
      totalCents: 3000,
      items: [
        { name: 'Sarah dessert', totalCents: 1000 },
        { name: 'Rachel dessert', totalCents: 500 },
        { name: 'Hannah dessert', totalCents: 1500 },
      ],
    })
  ).body;

  // Before allocation, settlement should refuse and name the unassigned items.
  const blocked = (await get(`/sessions/${session.id}/settlement`)).body;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'unassigned_items');
  assert.equal(blocked.unassignedItems.length, 6);

  await patch(`/sessions/${session.id}/items/${dinner.items[0].id}/allocation`, { participantIds: [sarah.id] });
  await patch(`/sessions/${session.id}/items/${dinner.items[1].id}/allocation`, { participantIds: [rachel.id] });
  await patch(`/sessions/${session.id}/items/${dinner.items[2].id}/allocation`, { participantIds: [hannah.id] });
  await patch(`/sessions/${session.id}/items/${dessert.items[0].id}/allocation`, { participantIds: [sarah.id] });
  await patch(`/sessions/${session.id}/items/${dessert.items[1].id}/allocation`, { participantIds: [rachel.id] });
  await patch(`/sessions/${session.id}/items/${dessert.items[2].id}/allocation`, { participantIds: [hannah.id] });

  const settled = (await get(`/sessions/${session.id}/settlement`)).body;
  assert.equal(settled.ok, true);

  const byId = Object.fromEntries(settled.balances.map((b) => [b.participantId, b]));
  assert.equal(byId[sarah.id].netCents, 6000);
  assert.equal(byId[rachel.id].netCents, -4500);
  assert.equal(byId[hannah.id].netCents, -1500);

  assert.equal(settled.transfers.length, 2);
  assert.deepEqual(settled.transfers, [
    { from: rachel.id, to: sarah.id, amountCents: 4500 },
    { from: hannah.id, to: sarah.id, amountCents: 1500 },
  ]);
});

test('rejects a bill with no items', async () => {
  const session = (await post('/sessions', {})).body;
  const sarah = (await post(`/sessions/${session.id}/participants`, { name: 'Sarah' })).body;

  const res = await post(`/sessions/${session.id}/bills`, {
    source: 'manual',
    payerId: sarah.id,
    totalCents: 100,
    items: [],
  });
  assert.equal(res.status, 400);
});

test('404s on a session that does not exist', async () => {
  const res = await get('/sessions/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
});
