import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeEach } from 'node:test';
import {
  DEFAULT_MODELS,
  modelsFromEnv,
  normalizeReceipt,
  parseModelJson,
  readReceipt,
  ReceiptReadError,
  _resetModelMemory,
} from './receiptReader.mjs';

beforeEach(() => _resetModelMemory());

const good = {
  isReceipt: true,
  merchant: '  Otter & Pebbles ',
  items: [
    { name: 'Teh peng', quantity: 3, lineTotal: 5.4 },
    { name: 'Kaya toast', quantity: 1, lineTotal: 5 },
  ],
  serviceCharge: 1.04,
  gst: 1.03,
  total: 12.47,
};

test('normalizeReceipt converts dollars to whole cents', () => {
  const r = normalizeReceipt(good);
  assert.equal(r.merchant, 'Otter & Pebbles');
  assert.deepEqual(r.items, [
    { name: 'Teh peng', qty: 3, totalCents: 540 },
    { name: 'Kaya toast', qty: 1, totalCents: 500 },
  ]);
  assert.equal(r.serviceChargeCents, 104);
  assert.equal(r.gstCents, 103);
  assert.equal(r.totalCents, 1247);
});

test('normalizeReceipt does not lose cents to floating point', () => {
  const r = normalizeReceipt({ items: [{ name: 'A', quantity: 1, lineTotal: 0.1 + 0.2 }, { name: 'B', quantity: 1, lineTotal: 12.35 }], total: 12.65 });
  assert.deepEqual(r.items.map((i) => i.totalCents), [30, 1235]);
});

test('bad lines are dropped and odd quantities become 1', () => {
  const r = normalizeReceipt({
    items: [
      { name: '', quantity: 1, lineTotal: 3 },
      { name: 'Free thing', quantity: 1, lineTotal: 0 },
      { name: 'Mystery', quantity: 1, lineTotal: 'ten' },
      { name: 'Real item', quantity: 2.5, lineTotal: 4 },
    ],
    total: 4,
  });
  assert.deepEqual(r.items, [{ name: 'Real item', qty: 1, totalCents: 400 }]);
});

test('a missing total falls back to what the lines add up to', () => {
  const r = normalizeReceipt({ items: [{ name: 'A', quantity: 1, lineTotal: 10 }], serviceCharge: 1, gst: 0.99, total: null });
  assert.equal(r.totalCents, 1199);
});

test('charges can never be negative, and long names are capped', () => {
  const r = normalizeReceipt({ items: [{ name: 'x'.repeat(200), quantity: 1, lineTotal: 1 }], serviceCharge: -5, gst: null, total: 1 });
  assert.equal(r.serviceChargeCents, 0);
  assert.equal(r.gstCents, 0);
  assert.equal(r.items[0].name.length, 80);
});

test('not a receipt, and nothing readable, are reported as such', () => {
  assert.throws(() => normalizeReceipt({ isReceipt: false, items: [] }), { code: 'NOT_A_RECEIPT' });
  assert.throws(() => normalizeReceipt({ isReceipt: true, items: [] }), { code: 'UNREADABLE' });
  assert.throws(() => normalizeReceipt(null), { code: 'UNREADABLE' });
});

test('parseModelJson accepts code fences and rejects junk', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseModelJson('sorry, I cannot'), { code: 'UNREADABLE' });
});

function fakeGemini(response) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, seen };
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });

test('readReceipt sends the photo to Gemini in the documented format', async () => {
  const { fetchImpl, seen } = fakeGemini(ok(good));
  const r = await readReceipt({ bytes: Buffer.from('PHOTO'), mimeType: 'image/png', apiKey: 'KEY123', models: ['gemini-test'], fetchImpl });
  assert.equal(r.totalCents, 1247);

  const { url, init } = seen[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(init.headers['x-goog-api-key'], 'KEY123');
  const body = JSON.parse(init.body);
  const parts = body.contents[0].parts;
  assert.ok(parts[0].text.includes('isReceipt'));
  assert.deepEqual(parts[1].inline_data, { mime_type: 'image/png', data: Buffer.from('PHOTO').toString('base64') });
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(!init.body.includes('KEY123'), 'the key must only be in the header');
});

test('rate limits and outages are BUSY; bad keys are CONFIG without leaking the key', async () => {
  for (const status of [429, 500, 503]) {
    const { fetchImpl } = fakeGemini({ ok: false, status });
    await assert.rejects(readReceipt({ bytes: Buffer.from('x'), mimeType: 'image/jpeg', apiKey: 'K', models: ['m'], fetchImpl }), { code: 'BUSY' });
  }
  const { fetchImpl } = fakeGemini({ ok: false, status: 403, text: async () => 'API key not valid' });
  await assert.rejects(
    readReceipt({ bytes: Buffer.from('x'), mimeType: 'image/jpeg', apiKey: 'SECRETKEY', models: ['m'], fetchImpl }),
    (err) => err.code === 'CONFIG' && !err.message.includes('SECRETKEY'),
  );
});

test('network failures, blocked images and empty answers are handled', async () => {
  const base = { bytes: Buffer.from('x'), mimeType: 'image/jpeg', apiKey: 'K', models: ['m'] };
  await assert.rejects(readReceipt({ ...base, fetchImpl: fakeGemini(new Error('down')).fetchImpl }), { code: 'BUSY' });
  await assert.rejects(
    readReceipt({ ...base, fetchImpl: fakeGemini({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }).fetchImpl }),
    { code: 'UNREADABLE' },
  );
  await assert.rejects(readReceipt({ ...base, fetchImpl: fakeGemini({ ok: true, status: 200, json: async () => ({}) }).fetchImpl }), { code: 'UNREADABLE' });
});

test('no API key is reported as a CONFIG problem', async () => {
  await assert.rejects(readReceipt({ bytes: Buffer.from('x'), mimeType: 'image/jpeg', apiKey: '' }), (e) => e instanceof ReceiptReadError && e.code === 'CONFIG');
});

function sequence(...responses) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url.split('/models/')[1].split(':')[0]);
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next;
  };
  return { fetchImpl, urls };
}
const gone = { ok: false, status: 404, text: async () => 'This model is no longer available' };
const base = { bytes: Buffer.from('x'), mimeType: 'image/jpeg', apiKey: 'K' };

test('a retired model (404) falls through to the next one', async () => {
  const { fetchImpl, urls } = sequence(gone, ok(good));
  const r = await readReceipt({ ...base, models: ['old-model', 'new-model'], fetchImpl });
  assert.equal(r.totalCents, 1247);
  assert.deepEqual(urls, ['old-model', 'new-model']);
});

test('the model that worked is tried first next time', async () => {
  const first = sequence(gone, ok(good));
  await readReceipt({ ...base, models: ['old-model', 'new-model'], fetchImpl: first.fetchImpl });
  const second = sequence(ok(good));
  await readReceipt({ ...base, models: ['old-model', 'new-model'], fetchImpl: second.fetchImpl });
  assert.deepEqual(second.urls, ['new-model']);
});

test('a quota error on one model also moves on to the next', async () => {
  const { fetchImpl, urls } = sequence({ ok: false, status: 429, text: async () => 'quota limit: 0' }, ok(good));
  await readReceipt({ ...base, models: ['a', 'b'], fetchImpl });
  assert.deepEqual(urls, ['a', 'b']);
});

test('a bad key (400) stops straight away: no other model would accept it', async () => {
  const { fetchImpl, urls } = sequence({ ok: false, status: 400, text: async () => 'API key not valid' });
  await assert.rejects(readReceipt({ ...base, models: ['a', 'b'], fetchImpl }), { code: 'CONFIG' });
  assert.deepEqual(urls, ['a']);
});

test('when every model fails, the error says what each one said', async () => {
  const { fetchImpl } = sequence(gone, { ok: false, status: 403, text: async () => 'not allowed on the free tier' });
  await assert.rejects(readReceipt({ ...base, models: ['a', 'b'], fetchImpl }), (err) => {
    assert.equal(err.code, 'CONFIG');
    assert.ok(err.message.includes('a: 404'));
    assert.ok(err.message.includes('b: 403 not allowed on the free tier'));
    assert.ok(!err.message.includes('K,'), 'no key in the message');
    return true;
  });
});

test('if any model was only rate limited, the user is told it is busy rather than broken', async () => {
  const { fetchImpl } = sequence(gone, { ok: false, status: 429, text: async () => '' });
  await assert.rejects(readReceipt({ ...base, models: ['a', 'b'], fetchImpl }), { code: 'BUSY' });
});

test('an unreachable Gemini is BUSY straight away, without trying every model', async () => {
  const { fetchImpl, urls } = sequence();
  await assert.rejects(readReceipt({ ...base, models: ['a', 'b', 'c'], fetchImpl }), { code: 'BUSY' });
  assert.deepEqual(urls, ['a']);
});

test('GEMINI_MODEL can be one name or a comma-separated list; otherwise the defaults apply', () => {
  assert.deepEqual(modelsFromEnv({ GEMINI_MODEL: 'x' }), ['x']);
  assert.deepEqual(modelsFromEnv({ GEMINI_MODEL: ' a , b ,, c ' }), ['a', 'b', 'c']);
  assert.deepEqual(modelsFromEnv({}), DEFAULT_MODELS);
  assert.ok(!DEFAULT_MODELS.includes('gemini-2.5-flash'), 'that model is being retired');
});

/* ----------------------------------------------- discounts and included charges */

// The real receipt that exposed both problems: wantons $6.80, app payment
// discount -$0.68, "GST $0.51 included", total $6.12.
const wantons = {
  isReceipt: true,
  merchant: null,
  items: [{ name: 'Wantons', quantity: 1, lineTotal: 6.8 }],
  discounts: [{ name: 'App payment discount', amount: 0.68, appliesTo: null }],
  serviceCharge: null,
  gst: 0.51,
  gstIncluded: true,
  serviceChargeIncluded: false,
  total: 6.12,
};

test('real receipt: the discount comes off the item and included GST is not added again', () => {
  const r = normalizeReceipt(wantons);
  assert.deepEqual(r.items, [{ name: 'Wantons', qty: 1, totalCents: 612 }]);
  assert.deepEqual(r.discounts, [{ name: 'App payment discount', cents: 68 }]);
  assert.equal(r.gstCents, 0);
  assert.equal(r.gstIncludedCents, 51);
  assert.equal(r.totalCents, 612);
});

test('the arithmetic catches included GST even when the AI forgets to say so', () => {
  const r = normalizeReceipt({ ...wantons, gstIncluded: false });
  assert.equal(r.gstCents, 0);
  assert.equal(r.gstIncludedCents, 51);
});

test('GST added on top stays added, even if the AI wrongly says it is included', () => {
  // 10.00 + 1.00 + 0.99 = 11.99 matches the printed total, so nothing is "included"
  const r = normalizeReceipt({ items: [{ name: 'A', quantity: 1, lineTotal: 10 }], serviceCharge: 1, gst: 0.99, gstIncluded: true, total: 11.99 });
  assert.equal(r.gstCents, 99);
  assert.equal(r.gstIncludedCents, 0);
  assert.equal(r.serviceChargeCents, 100);
});

test('when both charges are already in the prices, neither is added', () => {
  const r = normalizeReceipt({ items: [{ name: 'Set', quantity: 1, lineTotal: 10 }], serviceCharge: 1, gst: 0.82, total: 10 });
  assert.equal(r.serviceChargeCents, 0);
  assert.equal(r.gstCents, 0);
  assert.equal(r.serviceChargeIncludedCents, 100);
  assert.equal(r.gstIncludedCents, 82);
});

test('an included service charge is detected the same way', () => {
  const r = normalizeReceipt({ items: [{ name: 'Set', quantity: 1, lineTotal: 10 }], serviceCharge: 1, gst: 0.99, serviceChargeIncluded: true, total: 10.99 });
  assert.equal(r.serviceChargeCents, 0);
  assert.equal(r.serviceChargeIncludedCents, 100);
  assert.equal(r.gstCents, 99);
});

test('a bill-wide discount is spread across items to the exact cent', () => {
  const r = normalizeReceipt({
    items: [{ name: 'A', quantity: 1, lineTotal: 10 }, { name: 'B', quantity: 1, lineTotal: 10 }, { name: 'C', quantity: 1, lineTotal: 10 }],
    discounts: [{ name: 'Promo', amount: 1, appliesTo: null }],
    total: 29,
  });
  assert.equal(r.items.reduce((s, i) => s + i.totalCents, 0), 2900);
  // $1.00 over three equal items: the odd cent comes off the first item
  assert.deepEqual(r.items.map((i) => i.totalCents), [966, 967, 967]);
});

test('a discount that names an item comes off only that item', () => {
  const r = normalizeReceipt({
    items: [{ name: 'Wagyu Burger', quantity: 1, lineTotal: 15 }, { name: 'Fries', quantity: 1, lineTotal: 5 }],
    discounts: [{ name: '$2 off', amount: 2, appliesTo: 'wagyu burger' }],
    total: 18,
  });
  assert.deepEqual(r.items.map((i) => [i.name, i.totalCents]), [['Wagyu Burger', 1300], ['Fries', 500]]);
});

test('a discount naming an item that is not there is spread instead of lost', () => {
  const r = normalizeReceipt({
    items: [{ name: 'Burger', quantity: 1, lineTotal: 15 }, { name: 'Fries', quantity: 1, lineTotal: 5 }],
    discounts: [{ name: 'Promo', amount: 2, appliesTo: 'Sushi' }],
    total: 18,
  });
  // $2.00 spread in proportion to price: $1.50 off the $15 item, $0.50 off the $5 item
  assert.deepEqual(r.items.map((i) => i.totalCents), [1350, 450]);
});

test('a discount listed as a negative item is still handled as a discount', () => {
  const r = normalizeReceipt({ items: [{ name: 'Burger', quantity: 1, lineTotal: 10 }, { name: 'Voucher', quantity: 1, lineTotal: -2 }], total: 8 });
  assert.deepEqual(r.items, [{ name: 'Burger', qty: 1, totalCents: 800 }]);
  assert.deepEqual(r.discounts, [{ name: 'Voucher', cents: 200 }]);
});

test('an item discounted to nothing is dropped', () => {
  const r = normalizeReceipt({
    items: [{ name: 'Coffee', quantity: 1, lineTotal: 5 }, { name: 'Free cake', quantity: 1, lineTotal: 6 }],
    discounts: [{ name: '1-for-1', amount: 6, appliesTo: 'Free cake' }],
    total: 5,
  });
  assert.deepEqual(r.items.map((i) => i.name), ['Coffee']);
});

test('a discount can never push a price below zero; a bill discounted to nothing is refused', () => {
  const partly = normalizeReceipt({
    items: [{ name: 'A', quantity: 1, lineTotal: 5 }, { name: 'B', quantity: 1, lineTotal: 5 }],
    discounts: [{ name: 'Big', amount: 9, appliesTo: null }],
    total: 1,
  });
  assert.ok(partly.items.every((i) => i.totalCents > 0));
  assert.equal(partly.items.reduce((s, i) => s + i.totalCents, 0), 100);

  // More than the whole bill means something was misread: better to say so than save an empty bill.
  assert.throws(
    () => normalizeReceipt({ items: [{ name: 'A', quantity: 1, lineTotal: 5 }], discounts: [{ name: 'Mega', amount: 50, appliesTo: null }], total: 5 }),
    { code: 'UNREADABLE' },
  );
});

test('the reader asks the AI for discounts and included charges separately', async () => {
  const { fetchImpl, seen } = fakeGemini(ok(wantons));
  const r = await readReceipt({ bytes: Buffer.from('x'), mimeType: 'image/jpeg', apiKey: 'K', models: ['m'], fetchImpl });
  assert.equal(r.totalCents, 612);
  const prompt = JSON.parse(seen[0].init.body).contents[0].parts[0].text;
  assert.ok(prompt.includes('"discounts"'));
  assert.ok(prompt.includes('gstIncluded'));
});
