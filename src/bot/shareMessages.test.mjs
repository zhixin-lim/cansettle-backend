import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSessionSettlement } from '../settlementService.mjs';
import { groupMessageHtml, personalMessageHtml } from './shareMessages.mjs';

// The outing from the user's own screenshots: Bored Tacos ($35.50, paid by zhixin)
// and Soup Lodge ($6.12, paid by claire). claire ends up owing zhixin $11.63.
function outing(overrides = {}) {
  const ids = { z: 'p-zhixin', c: 'p-claire' };
  const both = [{ participantId: ids.z }, { participantId: ids.c }];
  return {
    ids,
    session: {
      participants: [
        { id: ids.z, name: 'zhixin' },
        { id: ids.c, name: 'claire' },
      ],
      bills: [
        {
          id: 'b1', name: 'Bored Tacos', payerId: ids.z, discountCents: 0, serviceChargeCents: 0, gstCents: 0, totalCents: 3550,
          items: [
            { id: 'i1', name: 'Ménage à Taco', quantity: 1, totalCents: 2100, allocations: both },
            { id: 'i2', name: 'Birria Beef Grilled Cheese LIMITED QTY', quantity: 1, totalCents: 1450, allocations: both },
          ],
        },
        {
          id: 'b2', name: 'SOUP LODGE PTE. LTD.', payerId: ids.c, discountCents: 68, serviceChargeCents: 0, gstCents: 0, totalCents: 612,
          items: [{ id: 'i3', name: '13. Pork Wantons Noodle(8pcs) 鲜肉云吞面 (8个)', quantity: 1, totalCents: 680, allocations: [{ participantId: ids.z }] }],
        },
      ],
      ...overrides,
    },
  };
}
const settle = (session) => {
  const s = computeSessionSettlement(session);
  assert.equal(s.ok, true);
  return s;
};

test('the settlement for the real outing matches the app: claire owes zhixin $11.63... plus the discount', () => {
  const { session, ids } = outing();
  const s = settle(session);
  // zhixin: 17.75 + (6.80 - 0.68) = 23.87 ; claire: 17.75 ; claire paid 6.12
  const byId = Object.fromEntries(s.balances.map((b) => [b.participantId, b]));
  assert.equal(byId[ids.z].shareCents, 2387);
  assert.equal(byId[ids.c].shareCents, 1775);
  assert.deepEqual(s.transfers, [{ from: ids.c, to: ids.z, amountCents: 1163 }]);
});

test('group message: structured, item names only, who pays whom, PayNow tap-to-copy', () => {
  const { session, ids } = outing();
  const text = groupMessageHtml(session, settle(session), { paynow: { [ids.z]: '90487510' } });
  const lines = text.split('\n');
  assert.equal(lines[0], '🧾 <b>Bored Tacos</b> — $35.50');
  assert.equal(lines[1], '<i>paid by zhixin</i>');
  assert.ok(text.includes('<b>Total — $41.62</b>'));
  assert.ok(text.includes('👤 <b>zhixin</b> — $23.87'));
  assert.ok(text.includes('Ménage à Taco, Birria Beef Grilled Cheese LIMITED QTY, 13. Pork Wantons'));
  assert.ok(text.includes('claire → zhixin <b>$11.63</b> · PayNow <code>90487510</code>'));
  assert.ok(!text.includes('$10.50'), 'no per-item amounts in the group message');
  assert.ok(text.includes('already included'));
  assert.ok(text.endsWith('React 🫡 once paid.'));
});

test('personal message: items with amounts, discount, share, what is owed and who to pay', () => {
  const { session, ids } = outing();
  const text = personalMessageHtml(session, settle(session), ids.c, { paynow: { [ids.z]: '90487510' } });
  assert.ok(text.startsWith('Eh <b>claire</b>, you owe <b>zhixin $11.63</b> for Bored Tacos + SOUP LODGE PTE. LTD. 🧾'));
  assert.ok(text.includes('Ménage à Taco (shared 2 ways) — $10.50'));
  assert.ok(text.includes('Birria Beef Grilled Cheese LIMITED QTY (shared 2 ways) — $7.25'));
  assert.ok(text.includes('Your share — $17.75'));
  assert.ok(text.includes('Already paid — $6.12'));
  assert.ok(text.includes('<b>You owe — $11.63</b>'));
  assert.ok(text.includes('PayNow <code>90487510</code> to zhixin'));
});

test('a discount is shown as its own line in the personal message', () => {
  const { session, ids } = outing();
  const s = settle(session);
  const z = personalMessageHtml(session, s, ids.z);
  assert.equal(z, null, 'zhixin is owed money, so there is nothing to send them');

  // make claire the one who bought the discounted noodles
  session.bills[1].items[0].allocations = [{ participantId: ids.c }];
  session.bills[1].payerId = ids.z;
  const text = personalMessageHtml(session, settle(session), ids.c);
  assert.ok(text.includes('Discount — -$0.68'));
});

test('a person who owes nothing gets no message, and PayNow is simply left out when unknown', () => {
  const { session, ids } = outing();
  const s = settle(session);
  assert.equal(personalMessageHtml(session, s, ids.z), null);
  assert.ok(!personalMessageHtml(session, s, ids.c).includes('PayNow'));
  assert.ok(!groupMessageHtml(session, s).includes('PayNow'));
});

test('names that come from receipts and people are escaped so Telegram accepts the message', () => {
  const { session, ids } = outing();
  session.participants[0].name = 'Z <b>&</b>';
  session.bills[0].name = 'Mac & Cheese <Shop>';
  session.bills[0].items[0].name = 'Fish & <chips>';
  const s = settle(session);
  for (const text of [groupMessageHtml(session, s), personalMessageHtml(session, s, ids.c)]) {
    assert.ok(!/Fish & <chips>/.test(text));
    assert.ok(!text.includes('<Shop>'));
    assert.ok(!text.includes('Z <b>&</b>'));
    assert.ok(text.includes('&lt;') && text.includes('&amp;'));
  }
});

test('a very long bill stays under Telegram\'s message length limit', () => {
  const { session, ids } = outing();
  session.bills[0].items = Array.from({ length: 120 }, (_, i) => ({
    id: `m${i}`, name: `Dish number ${i} with a fairly long name`, quantity: 1, totalCents: 100,
    allocations: [{ participantId: ids.z }, { participantId: ids.c }],
  }));
  session.bills[0].totalCents = 12000;
  const s = settle(session);
  const group = groupMessageHtml(session, s);
  const personal = personalMessageHtml(session, s, ids.c);
  assert.ok(group.length < 4096 && personal.length < 4096);
  assert.ok(group.includes('…and 95 more'));
});

test('everyone square: the group message says so', () => {
  const { session } = outing();
  session.bills = [{ id: 'b', name: 'Solo', payerId: 'p-zhixin', discountCents: 0, serviceChargeCents: 0, gstCents: 0, totalCents: 500,
    items: [{ id: 'i', name: 'Coffee', quantity: 1, totalCents: 500, allocations: [{ participantId: 'p-zhixin' }] }] }];
  assert.ok(groupMessageHtml(session, settle(session)).includes('All square'));
});
