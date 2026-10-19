import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../server.mjs';
import * as store from '../store/inMemoryStore.mjs';

const TOKEN = '123456:TEST-TOKEN';

function signInitData(user, token = TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(authDate), user: JSON.stringify(user) };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
}

let prepared; // what the fake Telegram was asked to prepare
let tgFails;
function start(env = { TELEGRAM_BOT_TOKEN: TOKEN }) {
  const tg = {
    savePreparedInlineMessage: async (args) => {
      if (tgFails) throw new Error('Telegram says no');
      prepared.push(args);
      return { id: 'PREPARED-1' };
    },
  };
  const server = createApp({ bot: { env, tg, handler: {} } }).listen(0);
  return { server, url: `http://localhost:${server.address().port}` };
}

// zhixin paid $20 for two items; claire had one, zhixin had one, so claire owes $10.
function makeSettledSession() {
  const session = store.createSession({});
  const z = store.addParticipant(session.id, { name: 'zhixin' });
  const c = store.addParticipant(session.id, { name: 'claire' });
  const bill = store.addBill(session.id, {
    name: 'Cafe', source: 'manual', payerId: z.id, totalCents: 2000,
    items: [{ name: 'Latte <large>', totalCents: 1000 }, { name: 'Cake', totalCents: 1000 }],
  });
  store.setItemAllocation(session.id, bill.items[0].id, [{ participantId: z.id }]);
  store.setItemAllocation(session.id, bill.items[1].id, [{ participantId: c.id }]);
  return { session, z, c, bill };
}

const share = (url, sessionId, body) =>
  fetch(`${url}/sessions/${sessionId}/telegram-share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const me = () => signInitData({ id: 4242, first_name: 'Zhi Xin' });

beforeEach(() => {
  store._resetAll();
  prepared = [];
  tgFails = false;
});

test('sharing to a group prepares a formatted message for the verified Telegram user', async () => {
  const { server, url } = start();
  try {
    const { session, z } = makeSettledSession();
    const res = await share(url, session.id, { initData: me(), kind: 'group', paynow: { [z.id]: '9048 7510' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { preparedMessageId: 'PREPARED-1' });

    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].userId, 4242, 'the user comes from the verified initData');
    const { result } = prepared[0];
    assert.equal(result.type, 'article');
    assert.equal(result.input_message_content.parse_mode, 'HTML');
    const text = result.input_message_content.message_text;
    assert.ok(text.includes('💸 <b>Who pays whom</b>'));
    assert.ok(text.includes('claire → zhixin <b>$10.00</b> · PayNow <code>9048 7510</code>'));
    assert.ok(text.includes('Latte &lt;large&gt;'), 'item names are escaped');
  } finally {
    server.close();
  }
});

test('sharing to one person prepares their own message', async () => {
  const { server, url } = start();
  try {
    const { session, c } = makeSettledSession();
    const res = await share(url, session.id, { initData: me(), kind: 'person', participantId: c.id });
    assert.equal(res.status, 200);
    const text = prepared[0].result.input_message_content.message_text;
    assert.ok(text.startsWith('Eh <b>claire</b>, you owe <b>zhixin $10.00</b> for Cafe'));
    assert.equal(prepared[0].result.title, 'Message for claire');
  } finally {
    server.close();
  }
});

test('nothing is prepared for someone who owes nothing', async () => {
  const { server, url } = start();
  try {
    const { session, z } = makeSettledSession();
    const res = await share(url, session.id, { initData: me(), kind: 'person', participantId: z.id });
    assert.equal(res.status, 409);
    assert.equal(prepared.length, 0);
  } finally {
    server.close();
  }
});

test('callers that cannot prove who they are are refused and nothing is sent', async () => {
  const { server, url } = start();
  try {
    const { session } = makeSettledSession();
    for (const initData of [undefined, '', 'junk', signInitData({ id: 1 }, '999:OTHER-BOT'), signInitData({ id: 1 }, TOKEN, 1000)]) {
      const res = await share(url, session.id, { initData, kind: 'group' });
      assert.equal(res.status, 401);
    }
    assert.equal(prepared.length, 0);
  } finally {
    server.close();
  }
});

test('a settlement that is not finished cannot be shared', async () => {
  const { server, url } = start();
  try {
    const { session, bill } = makeSettledSession();
    store.setItemAllocation(session.id, bill.items[1].id, []); // unassign one item
    const res = await share(url, session.id, { initData: me(), kind: 'group' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'unassigned_items');
  } finally {
    server.close();
  }
});

test('bad requests are rejected', async () => {
  const { server, url } = start();
  try {
    const { session } = makeSettledSession();
    assert.equal((await share(url, session.id, { initData: me(), kind: 'everyone' })).status, 400);
    assert.equal((await share(url, session.id, { initData: me(), kind: 'person', participantId: 'nobody' })).status, 400);
    assert.equal((await share(url, '00000000-0000-0000-0000-000000000000', { initData: me(), kind: 'group' })).status, 404);
  } finally {
    server.close();
  }
});

test('an expired settlement is refused', async () => {
  const { server, url } = start();
  try {
    const { session } = makeSettledSession();
    store._expireSession(session.id);
    assert.equal((await share(url, session.id, { initData: me(), kind: 'group' })).status, 410);
  } finally {
    server.close();
  }
});

test('PayNow numbers are checked: junk and strangers are dropped, nothing is injected', async () => {
  const { server, url } = start();
  try {
    const { session, z, c } = makeSettledSession();
    await share(url, session.id, {
      initData: me(), kind: 'group',
      paynow: { [z.id]: '<b>91234567</b>', [c.id]: '8123 4567', stranger: '99999999' },
    });
    const text = prepared[0].result.input_message_content.message_text;
    assert.ok(!text.includes('<b>91234567</b>'));
    assert.ok(!text.includes('99999999'));
    assert.ok(!text.includes('PayNow'), 'claire pays, so her number is not needed; zhixin\'s was junk');
  } finally {
    server.close();
  }
});

test('if Telegram cannot prepare the message the app is told to fall back to copying', async () => {
  const { server, url } = start();
  try {
    const { session } = makeSettledSession();
    tgFails = true;
    const res = await share(url, session.id, { initData: me(), kind: 'group' });
    assert.equal(res.status, 502);
    assert.ok((await res.json()).error.includes('copy'));
  } finally {
    server.close();
  }
});

test('without a bot token the share route does not exist', async () => {
  const { server, url } = start({});
  try {
    const { session } = makeSettledSession();
    assert.equal((await share(url, session.id, { initData: me(), kind: 'group' })).status, 404);
  } finally {
    server.close();
  }
});
