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

test('help is honest about the AI reader and the 24-hour limit', () => {
  const text = m.help();
  assert.ok(text.includes('An AI service reads the photo'));
  assert.ok(text.includes('24 hours'));
});
