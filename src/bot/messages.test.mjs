import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from './messages.mjs';

const receipt = {
  merchant: 'Otter & Pebbles',
  items: [
    { name: 'Teh <peng>', qty: 3, totalCents: 540 },
    { name: 'Kaya toast', qty: 1, totalCents: 500 },
  ],
  serviceChargeCents: 104,
  gstCents: 103,
  totalCents: 1247,
};

test('esc neutralises characters Telegram treats as HTML', () => {
  assert.equal(m.esc('a & b <c>'), 'a &amp; b &lt;c&gt;');
});

test('receiptReview escapes shop and item names from the receipt', () => {
  const text = m.receiptReview(receipt);
  assert.ok(text.includes('Otter &amp; Pebbles'));
  assert.ok(text.includes('Teh &lt;peng&gt;'));
  assert.ok(!text.includes('<peng>'));
});

test('receiptReview shows quantities, charges and total', () => {
  const text = m.receiptReview(receipt);
  assert.ok(text.includes('3x Teh &lt;peng&gt; — $5.40'));
  assert.ok(text.includes('Service charge — $1.04'));
  assert.ok(text.includes('GST — $1.03'));
  assert.ok(text.includes('<b>Total — $12.47</b>'));
});

test('receiptReview only warns when the numbers do not add up', () => {
  assert.ok(!m.receiptReview(receipt).includes('⚠️'));
  const off = m.receiptReview({ ...receipt, totalCents: 1300 });
  assert.ok(off.includes('⚠️'));
  assert.ok(off.includes('$12.47'));
  assert.ok(off.includes('$13.00'));
});

test('a very long receipt is capped to stay under the Telegram length limit', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `Item number ${i} with a long name`, qty: 1, totalCents: 100 }));
  const text = m.receiptReview({ items: many, totalCents: 20000 });
  assert.ok(text.length < 4096);
  assert.ok(text.includes('…and 160 more items'));
});

test('counts are pluralised correctly', () => {
  assert.ok(m.anotherReceipt(1).startsWith('1 receipt so far'));
  assert.ok(m.anotherReceipt(2).startsWith('2 receipts so far'));
  assert.ok(m.readyToOpen({ receiptCount: 1, totalCents: 1000 }).includes('1 receipt, $10.00'));
  assert.ok(m.readyToOpen({ receiptCount: 2, totalCents: 1000 }).includes('2 receipts, $10.00'));
});

test('help is honest about who reads the photo, and the 24-hour limit', () => {
  const text = m.help();
  assert.ok(text.includes("Google's Gemini AI reads the photo"));
  assert.ok(text.includes('improve its products'));
  assert.ok(text.includes('add the bill by hand'));
  assert.ok(text.includes('24 hours'));
});

test('welcome points to the Gemini disclosure before the first photo', () => {
  assert.ok(m.welcome().includes("Google's Gemini AI reads your photo"));
});

test('the flow templates exist and stay short', () => {
  for (const fn of [m.askForPhoto, m.nextReceipt, m.tooMany, m.staleButton, m.privateOnly, m.sendAPhoto]) {
    const text = fn();
    assert.ok(text.length > 0 && text.length < 200);
  }
});

test('a discount and an included GST are explained, and do not trigger the mismatch warning', () => {
  // Real case: wantons $6.80, app discount -$0.68, "GST $0.51 included", total $6.12
  const text = m.receiptReview({
    merchant: null,
    items: [{ name: 'Wantons', qty: 1, totalCents: 680 }],
    discountCents: 68,
    discounts: [{ name: 'App payment discount', cents: 68, onItem: false }],
    serviceChargeCents: 0,
    gstCents: 0,
    serviceChargeIncludedCents: 0,
    gstIncludedCents: 51,
    totalCents: 612,
  });
  assert.ok(text.includes('Wantons — $6.80'));
  assert.ok(text.includes('App payment discount — -$0.68 (taken off the total)'));
  assert.ok(text.includes('GST — $0.51 (already in the prices)'));
  assert.ok(text.includes('<b>Total — $6.12</b>'));
  assert.ok(!text.includes('⚠️'));
});

test('an item-specific discount is described as coming off the item', () => {
  const text = m.receiptReview({
    items: [{ name: 'Burger', qty: 1, totalCents: 1300 }],
    discounts: [{ name: '$2 off', cents: 200, onItem: true }],
    totalCents: 1300,
  });
  assert.ok(text.includes('$2 off — -$2.00 (already taken off the item)'));
  assert.ok(!text.includes('⚠️'));
});

test('the mismatch warning accounts for a bill discount', () => {
  const base = { items: [{ name: 'A', qty: 1, totalCents: 1000 }], discountCents: 100, discounts: [{ name: 'x', cents: 100, onItem: false }] };
  assert.ok(!m.receiptReview({ ...base, totalCents: 900 }).includes('⚠️'));
  assert.ok(m.receiptReview({ ...base, totalCents: 1000 }).includes('⚠️'));
});

test('an included service charge is explained the same way', () => {
  const text = m.receiptReview({
    items: [{ name: 'Set lunch', qty: 1, totalCents: 1000 }],
    serviceChargeIncludedCents: 100,
    totalCents: 1000,
  });
  assert.ok(text.includes('Service charge — $1.00 (already in the prices)'));
  assert.ok(!text.includes('⚠️'));
});

test('welcome and help point to manual entry', () => {
  assert.ok(m.welcome().includes('/manual'));
  assert.ok(m.help().includes('/manual'));
  assert.ok(m.manualReady().includes('by hand'));
  assert.ok(m.buttons.manual.length > 0);
});
