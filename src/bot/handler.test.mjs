import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store/inMemoryStore.mjs';
import { computeSessionSettlement } from '../settlementService.mjs';
import { createBotHandler, createLimiter, toBillItems } from './handler.mjs';
import { ReceiptReadError } from './receiptReader.mjs';

const CHAT = 555;
const receipt = {
  merchant: 'Otter & Pebbles',
  items: [
    { name: 'Udon', qty: 1, totalCents: 1790 },
    { name: 'Teh peng', qty: 3, totalCents: 540 },
  ],
  serviceChargeCents: 233,
  gstCents: 205,
  totalCents: 4768 - 2000, // deliberately not equal to the lines: only used where mismatch is wanted
};
const balanced = { ...receipt, totalCents: 1790 + 540 + 233 + 205 };

function fakeTelegram() {
  const calls = [];
  let nextId = 100;
  const rec = (type) => async (...args) => {
    calls.push({ type, args });
    return { message_id: nextId++ };
  };
  return {
    calls,
    sendMessage: rec('send'),
    editMessageText: rec('edit'),
    removeButtons: rec('removeButtons'),
    answerCallbackQuery: rec('answer'),
    downloadFile: async () => ({ bytes: Buffer.from('img'), filePath: 'photos/a.jpg' }),
    texts: () => calls.filter((c) => c.type === 'send' || c.type === 'edit').map((c) => c.args[c.type === 'send' ? 1 : 2]),
    last: (type) => [...calls].reverse().find((c) => c.type === type),
  };
}

let tg, reader, bot, errors;
const makeBot = (opts = {}) => {
  errors = [];
  tg = fakeTelegram();
  reader = async () => balanced;
  bot = createBotHandler({
    tg,
    readReceipt: (...a) => reader(...a),
    store,
    miniAppUrl: 'https://app.example/',
    log: { error: (m) => errors.push(m) },
    ...opts,
  });
};
beforeEach(() => {
  store._resetAll();
  makeBot();
});

let uid = 1;
const text = (t, extra = {}) => ({ update_id: uid++, message: { chat: { id: CHAT, type: 'private' }, from: { first_name: 'Zhi Xin' }, text: t, ...extra } });
const photo = () => ({ update_id: uid++, message: { chat: { id: CHAT, type: 'private' }, from: { first_name: 'Zhi Xin' }, photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
const press = (data) => ({ update_id: uid++, callback_query: { id: 'cb' + uid, data, from: { first_name: 'Zhi Xin' }, message: { message_id: 9, chat: { id: CHAT, type: 'private' } } } });

async function sendPhotoAndConfirm() {
  await bot.handleUpdate(photo());
  const pending = store.getChatState(CHAT).pending;
  await bot.handleUpdate(press(`ok:${pending.id}`));
}

test('/start shows the welcome and forgets any earlier settlement', async () => {
  store.setChatState(CHAT, { sessionId: 'old' });
  await bot.handleUpdate(text('/start'));
  assert.ok(tg.texts()[0].includes("Hi, I'm CanSettle"));
  assert.equal(store.getChatState(CHAT), null);
});

test('commands with the bot name attached still work', async () => {
  await bot.handleUpdate(text('/help@CanSettle_bot'));
  assert.ok(tg.texts()[0].includes('How CanSettle works'));
});

test('a photo is read, shown for review, and waits for confirmation', async () => {
  await bot.handleUpdate(photo());
  assert.equal(tg.calls[0].type, 'send'); // "Reading your receipt…"
  assert.equal(tg.calls[0].args[1], 'Reading your receipt… 🧾');

  const review = tg.last('edit');
  assert.ok(review.args[2].includes('Receipt 1 — Otter &amp; Pebbles'));
  const buttons = review.args[3].reply_markup.inline_keyboard[0];
  assert.match(buttons[0].callback_data, /^ok:[0-9a-f]{8}$/);
  assert.match(buttons[1].callback_data, /^retake:/);
  assert.deepEqual(store.getChatState(CHAT).pending.receipt, balanced);
  assert.equal(store.getSessionMeta, store.getSessionMeta); // nothing saved to a settlement yet
});

test('the largest version of the photo is the one that is read', async () => {
  const downloaded = [];
  tg.downloadFile = async (id) => (downloaded.push(id), { bytes: Buffer.from('i'), filePath: 'p.jpg' });
  await bot.handleUpdate(photo());
  assert.deepEqual(downloaded, ['big']);
});

test('"Looks right" saves the receipt as a bill paid by the sender', async () => {
  await sendPhotoAndConfirm();
  const state = store.getChatState(CHAT);
  assert.equal(state.receiptCount, 1);
  assert.equal(state.pending, undefined);

  const session = store.getSession(state.sessionId);
  assert.deepEqual(session.participants.map((p) => p.name), ['Zhi Xin']);
  const bill = session.bills[0];
  assert.equal(bill.name, 'Otter & Pebbles');
  assert.equal(bill.source, 'receipt');
  assert.equal(bill.payerId, session.participants[0].id);
  assert.equal(bill.totalCents, balanced.totalCents);
  assert.equal(bill.serviceChargeCents, 233);
  assert.equal(bill.gstCents, 205);
  assert.deepEqual(bill.items.map((i) => [i.name, i.quantity, i.unitPriceCents, i.totalCents]), [
    ['Udon', 1, 1790, 1790],
    ['Teh peng', 3, 180, 540],
  ]);

  const askMore = tg.last('send');
  assert.ok(askMore.args[1].includes('Got it ✅ Otter &amp; Pebbles'));
  assert.ok(askMore.args[1].includes('1 receipt so far'));
  assert.deepEqual(askMore.args[2].reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['more', 'done']);
});

test('two receipts, then "That\'s all" opens the app on the same settlement', async () => {
  await sendPhotoAndConfirm();
  await bot.handleUpdate(press('more'));
  assert.equal(tg.last('send').args[1], 'Send the next receipt 📸');
  await sendPhotoAndConfirm();
  const sessionId = store.getChatState(CHAT).sessionId;
  assert.equal(store.getSession(sessionId).bills.length, 2);

  await bot.handleUpdate(press('done'));
  const done = tg.last('send');
  assert.ok(done.args[1].includes('2 receipts'));
  const button = done.args[2].reply_markup.inline_keyboard[0][0];
  assert.deepEqual(button.web_app, { url: `https://app.example/?session=${sessionId}` });
  assert.equal(store.getChatState(CHAT), null, 'the next photo should start a fresh settlement');
  assert.ok(store.getSession(sessionId), 'the settlement itself stays available in the app');
});

test('"Retake" discards the receipt and asks again', async () => {
  await bot.handleUpdate(photo());
  const { id } = store.getChatState(CHAT).pending;
  await bot.handleUpdate(press(`retake:${id}`));
  assert.equal(store.getChatState(CHAT).pending, undefined);
  assert.equal(tg.last('send').args[1], 'No problem. Send the receipt photo again 📸');
});

test('a button from an older receipt is refused and cannot add a bill twice', async () => {
  await bot.handleUpdate(photo());
  const { id } = store.getChatState(CHAT).pending;
  await bot.handleUpdate(press(`ok:${id}`));
  await bot.handleUpdate(press(`ok:${id}`)); // pressed again
  assert.ok(tg.last('send').args[1].includes('older message'));
  const sessionId = store.getChatState(CHAT).sessionId;
  assert.equal(store.getSession(sessionId).bills.length, 1);

  await bot.handleUpdate(press('ok:deadbeef'));
  assert.ok(tg.last('send').args[1].includes('older message'));
});

test('buttons with no conversation behind them are refused', async () => {
  await bot.handleUpdate(press('done'));
  assert.ok(tg.last('send').args[1].includes('older message'));
});

test('a newer photo replaces the one waiting for review', async () => {
  await bot.handleUpdate(photo());
  const first = store.getChatState(CHAT).pending.id;
  await bot.handleUpdate(photo());
  assert.notEqual(store.getChatState(CHAT).pending.id, first);
  await bot.handleUpdate(press(`ok:${first}`));
  assert.ok(tg.last('send').args[1].includes('older message'));
});

test('reader problems become friendly messages', async () => {
  const cases = [
    ['NOT_A_RECEIPT', "doesn't look like a receipt"],
    ['UNREADABLE', "couldn't read that one"],
    ['BUSY', "I'm a bit busy"],
    ['CONFIG', "I'm a bit busy"],
  ];
  for (const [code, expected] of cases) {
    makeBot();
    reader = async () => {
      throw new ReceiptReadError(code, 'details');
    };
    await bot.handleUpdate(photo());
    assert.ok(tg.last('edit').args[2].includes(expected), code);
    assert.equal(store.getChatState(CHAT), null, 'nothing is remembered after a failed read');
    // only problems on our side (BUSY, CONFIG) are logged for the owner
    assert.equal(errors.length, code === 'BUSY' || code === 'CONFIG' ? 1 : 0, code);
  }
});

test('an unexpected failure is logged and the user gets the busy message', async () => {
  reader = async () => {
    throw new Error('boom');
  };
  await bot.handleUpdate(photo());
  assert.ok(tg.last('edit').args[2].includes("I'm a bit busy"));
  assert.ok(errors[0].includes('boom'));
});

test('an expired settlement is dropped with a clear message', async () => {
  await sendPhotoAndConfirm();
  store._expireSession(store.getChatState(CHAT).sessionId);
  await bot.handleUpdate(press('more'));
  await sendPhotoAndConfirm();
  assert.ok(tg.last('send').args[1].includes('has expired'));
  assert.equal(store.getChatState(CHAT), null);
});

test('too many photos in a short time are slowed down', async () => {
  makeBot({ limiter: createLimiter({ max: 2 }) });
  await bot.handleUpdate(photo());
  await bot.handleUpdate(photo());
  const calls = tg.calls.length;
  await bot.handleUpdate(photo());
  assert.ok(tg.last('send').args[1].includes('a lot of receipts'));
  assert.equal(tg.calls.length, calls + 1, 'no photo was downloaded or read');
});

test('the limiter forgets old hits', () => {
  let t = 0;
  const limiter = createLimiter({ max: 1, windowMs: 1000, now: () => t });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  t = 1500;
  assert.equal(limiter.allow('a'), true);
});

test('text and non-image files get a nudge; image files are accepted as photos', async () => {
  await bot.handleUpdate(text('hello'));
  assert.equal(tg.last('send').args[1], 'Send me a photo of the receipt 📸');

  await bot.handleUpdate({ update_id: uid++, message: { chat: { id: CHAT, type: 'private' }, document: { file_id: 'd', mime_type: 'application/pdf' } } });
  assert.equal(tg.last('send').args[1], 'Send me a photo of the receipt 📸');

  await bot.handleUpdate({ update_id: uid++, message: { chat: { id: CHAT, type: 'private' }, document: { file_id: 'd', mime_type: 'image/png' } } });
  assert.ok(tg.last('edit').args[2].includes('Receipt 1'));
});

test('oversized files are refused before downloading', async () => {
  let downloaded = false;
  tg.downloadFile = async () => ((downloaded = true), {});
  await bot.handleUpdate({ update_id: uid++, message: { chat: { id: CHAT, type: 'private' }, document: { file_id: 'd', mime_type: 'image/png', file_size: 50 * 1024 * 1024 } } });
  assert.equal(downloaded, false);
  assert.ok(tg.last('send').args[1].includes("couldn't read that one"));
});

test('group chats are told to use a private chat, and only when addressed with a command', async () => {
  await bot.handleUpdate({ update_id: uid++, message: { chat: { id: -1, type: 'group' }, text: '/start' } });
  assert.ok(tg.last('send').args[1].includes('private chats'));
  const before = tg.calls.length;
  await bot.handleUpdate({ update_id: uid++, message: { chat: { id: -1, type: 'group' }, text: 'chatting' } });
  assert.equal(tg.calls.length, before);
});

test('the same update delivered twice is handled once', async () => {
  const update = text('/help');
  await bot.handleUpdate(update);
  await bot.handleUpdate(update);
  assert.equal(tg.calls.filter((c) => c.type === 'send').length, 1);
});

test('/cancel forgets the settlement in progress', async () => {
  await bot.handleUpdate(text('/cancel'));
  assert.ok(tg.last('send').args[1].includes('Nothing to cancel'));
  await bot.handleUpdate(photo());
  await bot.handleUpdate(text('/cancel'));
  assert.ok(tg.last('send').args[1].includes('dropped'));
  assert.equal(store.getChatState(CHAT), null);
});

test('one chat\'s updates run in order even when they arrive together', async () => {
  // The first message is slow to send. Without per-chat ordering the second
  // would finish first, so the order of completion shows whether they queued.
  const finished = [];
  tg.sendMessage = async (_c, t) => {
    const isHelp = t.includes('How CanSettle works');
    await new Promise((r) => setTimeout(r, isHelp ? 40 : 0));
    finished.push(isHelp ? 'help' : 'cancel');
    return { message_id: 1 };
  };
  await Promise.all([bot.handleUpdate(text('/help')), bot.handleUpdate(text('/cancel'))]);
  assert.deepEqual(finished, ['help', 'cancel']);
});

test('toBillItems never loses a cent', () => {
  assert.deepEqual(toBillItems([{ name: 'Tea', qty: 3, totalCents: 540 }]), [{ name: 'Tea', quantity: 3, unitPriceCents: 180, totalCents: 540 }]);
  assert.deepEqual(toBillItems([{ name: 'Beer', qty: 3, totalCents: 1000 }]), [{ name: 'Beer (x3)', quantity: 1, unitPriceCents: 1000, totalCents: 1000 }]);
  assert.deepEqual(toBillItems([{ name: 'Voucher', qty: 1, totalCents: -200 }]), [{ name: 'Voucher', quantity: 1, unitPriceCents: -200, totalCents: -200 }]);
});

test('a receipt with a discount and an awkward quantity still settles exactly', async () => {
  reader = async () => ({
    merchant: 'Cafe',
    items: [
      { name: 'Beer', qty: 3, totalCents: 1000 },
      { name: 'Burger', qty: 1, totalCents: 1500 },
      { name: 'Voucher', qty: 1, totalCents: -300 },
    ],
    serviceChargeCents: 220,
    gstCents: 210,
    totalCents: 1000 + 1500 - 300 + 220 + 210,
  });
  await sendPhotoAndConfirm();
  const sessionId = store.getChatState(CHAT).sessionId;
  const session = store.getSession(sessionId);
  const friend = store.addParticipant(sessionId, { name: 'Friend' });
  const host = session.participants[0];
  session.bills[0].items.forEach((item, i) => store.setItemAllocation(sessionId, item.id, [{ participantId: i % 2 === 0 ? host.id : friend.id }]));

  const settlement = computeSessionSettlement(store.getSession(sessionId));
  assert.equal(settlement.ok, true);
  assert.equal(settlement.billResults[0].reconciled, true);
  assert.equal(settlement.balances.reduce((s, b) => s + b.netCents, 0), 0);
});

test('real receipt end to end: the review has no warning and the saved bill matches the printed total', async () => {
  reader = async () => ({
    merchant: null,
    items: [{ name: 'Wantons', qty: 1, totalCents: 612 }],
    discounts: [{ name: 'App payment discount', cents: 68 }],
    serviceChargeCents: 0,
    gstCents: 0,
    serviceChargeIncludedCents: 0,
    gstIncludedCents: 51,
    totalCents: 612,
  });
  await bot.handleUpdate(photo());
  const review = tg.last('edit').args[2];
  assert.ok(!review.includes('⚠️'));
  assert.ok(review.includes('already in the prices'));

  await bot.handleUpdate(press(`ok:${store.getChatState(CHAT).pending.id}`));
  const sessionId = store.getChatState(CHAT).sessionId;
  const bill = store.getSession(sessionId).bills[0];
  assert.deepEqual(bill.items.map((i) => i.totalCents), [612]);
  assert.equal(bill.gstCents, 0);
  assert.equal(bill.totalCents, 612);

  const friend = store.addParticipant(sessionId, { name: 'Friend' });
  const host = store.getSession(sessionId).participants[0];
  store.setItemAllocation(sessionId, bill.items[0].id, [{ participantId: host.id }, { participantId: friend.id }]);
  const settlement = computeSessionSettlement(store.getSession(sessionId));
  assert.equal(settlement.ok, true);
  assert.deepEqual(settlement.transfers, [{ from: friend.id, to: host.id, amountCents: 306 }]);
});
