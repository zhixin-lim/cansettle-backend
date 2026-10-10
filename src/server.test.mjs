import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.mjs';
import { _resetAll, _expireSession, deleteExpiredSessions } from './store/inMemoryStore.mjs';

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

async function del(path) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
  return { status: res.status };
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

  await patch(`/sessions/${session.id}/items/${dinner.items[0].id}/allocation`, { allocations: [{ participantId: sarah.id }] });
  await patch(`/sessions/${session.id}/items/${dinner.items[1].id}/allocation`, { allocations: [{ participantId: rachel.id }] });
  await patch(`/sessions/${session.id}/items/${dinner.items[2].id}/allocation`, { allocations: [{ participantId: hannah.id }] });
  await patch(`/sessions/${session.id}/items/${dessert.items[0].id}/allocation`, { allocations: [{ participantId: sarah.id }] });
  await patch(`/sessions/${session.id}/items/${dessert.items[1].id}/allocation`, { allocations: [{ participantId: rachel.id }] });
  await patch(`/sessions/${session.id}/items/${dessert.items[2].id}/allocation`, { allocations: [{ participantId: hannah.id }] });

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

test('rename and remove a participant', async () => {
  const session = (await post('/sessions', {})).body;
  const kai = (await post(`/sessions/${session.id}/participants`, { name: 'Kai' })).body;

  const renamed = await patch(`/sessions/${session.id}/participants/${kai.id}`, { name: 'Kai Lim' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Kai Lim');

  const removed = await del(`/sessions/${session.id}/participants/${kai.id}`);
  assert.equal(removed.status, 204);

  const after = await get(`/sessions/${session.id}`);
  assert.equal(after.body.participants.length, 0);
});

test('refuses to remove a participant who is the payer on a bill', async () => {
  const session = (await post('/sessions', {})).body;
  const sarah = (await post(`/sessions/${session.id}/participants`, { name: 'Sarah' })).body;
  await post(`/sessions/${session.id}/bills`, {
    source: 'manual',
    payerId: sarah.id,
    totalCents: 1000,
    items: [{ name: 'Item', totalCents: 1000 }],
  });

  const res = await del(`/sessions/${session.id}/participants/${sarah.id}`);
  assert.equal(res.status, 409);
});

test('deleting a participant strips them from any item allocation', async () => {
  const session = (await post('/sessions', {})).body;
  const sarah = (await post(`/sessions/${session.id}/participants`, { name: 'Sarah' })).body;
  const kai = (await post(`/sessions/${session.id}/participants`, { name: 'Kai' })).body;

  const bill = (
    await post(`/sessions/${session.id}/bills`, {
      source: 'manual',
      payerId: sarah.id,
      totalCents: 1000,
      items: [{ name: 'Shared item', totalCents: 1000 }],
    })
  ).body;
  await patch(`/sessions/${session.id}/items/${bill.items[0].id}/allocation`, {
    allocations: [{ participantId: sarah.id }, { participantId: kai.id }],
  });

  await del(`/sessions/${session.id}/participants/${kai.id}`);

  const after = await get(`/sessions/${session.id}`);
  const item = after.body.bills[0].items[0];
  assert.deepEqual(item.allocations.map((a) => a.participantId), [sarah.id]);
});

test('delete a bill removes it from the session', async () => {
  const session = (await post('/sessions', {})).body;
  const sarah = (await post(`/sessions/${session.id}/participants`, { name: 'Sarah' })).body;
  const bill = (
    await post(`/sessions/${session.id}/bills`, {
      source: 'manual',
      payerId: sarah.id,
      totalCents: 1000,
      items: [{ name: 'Item', totalCents: 1000 }],
    })
  ).body;

  const res = await del(`/sessions/${session.id}/bills/${bill.id}`);
  assert.equal(res.status, 204);

  const after = await get(`/sessions/${session.id}`);
  assert.equal(after.body.bills.length, 0);
});

test('unequal quantities on a shared item, via the real API', async () => {
  const session = (await post('/sessions', {})).body;
  const rachel = (await post(`/sessions/${session.id}/participants`, { name: 'Rachel' })).body;
  const hannah = (await post(`/sessions/${session.id}/participants`, { name: 'Hannah' })).body;

  const bill = (
    await post(`/sessions/${session.id}/bills`, {
      source: 'manual',
      payerId: rachel.id,
      totalCents: 900,
      items: [{ name: 'Sushi plates', totalCents: 900, quantity: 3 }],
    })
  ).body;

  await patch(`/sessions/${session.id}/items/${bill.items[0].id}/allocation`, {
    allocations: [
      { participantId: rachel.id, quantity: 1 },
      { participantId: hannah.id, quantity: 2 },
    ],
  });

  const settled = (await get(`/sessions/${session.id}/settlement`)).body;
  assert.equal(settled.ok, true);
  const byId = Object.fromEntries(settled.balances.map((b) => [b.participantId, b]));
  assert.equal(byId[rachel.id].shareCents, 300);
  assert.equal(byId[hannah.id].shareCents, 600);
});

test('an expired session is refused with 410 on reads and writes', async () => {
  const session = (await post('/sessions', {})).body;
  _expireSession(session.id);

  const read = await get(`/sessions/${session.id}`);
  assert.equal(read.status, 410);
  assert.equal(read.body.code, 'SESSION_EXPIRED');

  const write = await post(`/sessions/${session.id}/participants`, { name: 'Late' });
  assert.equal(write.status, 410);

  const settle = await get(`/sessions/${session.id}/settlement`);
  assert.equal(settle.status, 410);
});

test('the expiry sweep deletes expired sessions and keeps live ones', async () => {
  const expired = (await post('/sessions', {})).body;
  const live = (await post('/sessions', {})).body;
  _expireSession(expired.id);

  const removed = deleteExpiredSessions();
  assert.equal(removed, 1);

  assert.equal((await get(`/sessions/${expired.id}`)).status, 404);
  assert.equal((await get(`/sessions/${live.id}`)).status, 200);
});

test('a bill name round-trips through the session', async () => {
  const session = (await post('/sessions', {})).body;
  const sarah = (await post(`/sessions/${session.id}/participants`, { name: 'Sarah' })).body;

  const bill = (
    await post(`/sessions/${session.id}/bills`, {
      name: 'Otter & Pebbles',
      source: 'manual',
      payerId: sarah.id,
      totalCents: 1000,
      items: [{ name: 'Item', totalCents: 1000 }],
    })
  ).body;
  assert.equal(bill.name, 'Otter & Pebbles');

  const after = (await get(`/sessions/${session.id}`)).body;
  assert.equal(after.bills[0].name, 'Otter & Pebbles');
});
