import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dollarsToCents as $ } from './money.mjs';
import { calculateBill } from './bill.mjs';
import { calculateNetBalances, computeTransfers, calculateSettlement } from './settlement.mjs';

// --- Example 1: basic proportional SC/GST split (Alice/Bob, $100/$10/$9.90) ---
test('Example 1: two people, simple proportional SC/GST allocation', () => {
  const bill = {
    id: 'bill-1',
    payerId: 'alice',
    participantIds: ['alice', 'bob'],
    items: [
      { id: 'alice-items', totalCents: $(60), allocations: [{ participantId: 'alice' }] },
      { id: 'bob-items', totalCents: $(40), allocations: [{ participantId: 'bob' }] },
    ],
    serviceChargeCents: $(10),
    gstCents: $(9.9),
    totalCents: $(119.9),
  };

  const result = calculateBill(bill);
  assert.equal(result.reconciled, true);

  const alice = result.shares.find((s) => s.participantId === 'alice');
  const bob = result.shares.find((s) => s.participantId === 'bob');

  assert.equal(alice.serviceChargeCents, $(6));
  assert.equal(alice.gstCents, $(5.94));
  assert.equal(alice.totalCents, $(71.94));

  assert.equal(bob.serviceChargeCents, $(4));
  assert.equal(bob.gstCents, $(3.96));
  assert.equal(bob.totalCents, $(47.96));

  assert.equal(alice.totalCents + bob.totalCents, $(119.9));
});

// --- Example 2: rounding-residual rule (Alice/Bob/Cherie, uneven $100 split) ---
test('Example 2: rounding residual goes to the largest pre-tax share', () => {
  const bill = {
    id: 'bill-2',
    payerId: 'alice',
    participantIds: ['alice', 'bob', 'cherie'],
    items: [
      // Deliberately not evenly divisible by 3, to force the rounding path.
      { id: 'a', totalCents: $(33.34), allocations: [{ participantId: 'alice' }] },
      { id: 'b', totalCents: $(33.33), allocations: [{ participantId: 'bob' }] },
      { id: 'c', totalCents: $(33.33), allocations: [{ participantId: 'cherie' }] },
    ],
    serviceChargeCents: $(10),
    gstCents: $(9.9),
    totalCents: $(119.9),
  };

  const result = calculateBill(bill);
  assert.equal(result.reconciled, true);

  const byId = Object.fromEntries(result.shares.map((s) => [s.participantId, s]));

  assert.equal(byId.alice.totalCents, $(39.98));
  assert.equal(byId.bob.totalCents, $(39.96));
  assert.equal(byId.cherie.totalCents, $(39.96));

  const sum = result.shares.reduce((s, x) => s + x.totalCents, 0);
  assert.equal(sum, $(119.9));
});

// --- Example 3: multi-bill, multi-payer, global netting (Sarah/Rachel/Hannah) ---
test('Example 3: global session netting across two bills produces 2 transfers, not 3', () => {
  const dinner = {
    id: 'dinner',
    payerId: 'sarah',
    participantIds: ['sarah', 'rachel', 'hannah'],
    items: [
      { id: 'd1', totalCents: $(50), allocations: [{ participantId: 'sarah' }] },
      { id: 'd2', totalCents: $(40), allocations: [{ participantId: 'rachel' }] },
      { id: 'd3', totalCents: $(30), allocations: [{ participantId: 'hannah' }] },
    ],
    serviceChargeCents: 0,
    gstCents: 0,
    totalCents: $(120),
  };

  const dessert = {
    id: 'dessert',
    payerId: 'hannah',
    participantIds: ['sarah', 'rachel', 'hannah'],
    items: [
      { id: 'e1', totalCents: $(10), allocations: [{ participantId: 'sarah' }] },
      { id: 'e2', totalCents: $(5), allocations: [{ participantId: 'rachel' }] },
      { id: 'e3', totalCents: $(15), allocations: [{ participantId: 'hannah' }] },
    ],
    serviceChargeCents: 0,
    gstCents: 0,
    totalCents: $(30),
  };

  const settlement = calculateSettlement([dinner, dessert], ['sarah', 'rachel', 'hannah']);
  assert.equal(settlement.ok, true);

  const byId = Object.fromEntries(settlement.balances.map((b) => [b.participantId, b]));
  assert.equal(byId.sarah.netCents, $(60));
  assert.equal(byId.rachel.netCents, $(-45));
  assert.equal(byId.hannah.netCents, $(-15));

  assert.equal(settlement.transfers.length, 2);
  assert.deepEqual(settlement.transfers, [
    { from: 'rachel', to: 'sarah', amountCents: $(45) },
    { from: 'hannah', to: 'sarah', amountCents: $(15) },
  ]);
});

// --- Unequal quantities on a shared item (e.g. running sushi plates) ---
test('Unequal quantities: a shared item splits proportionally to quantity, not headcount', () => {
  const bill = {
    id: 'sushi',
    payerId: 'rachel',
    participantIds: ['rachel', 'hannah'],
    items: [
      // 3 plates of the same dish, $9.00 total ($3/plate). Rachel had 1,
      // Hannah had 2 - NOT a 50/50 split.
      {
        id: 'plates',
        totalCents: $(9),
        allocations: [
          { participantId: 'rachel', quantity: 1 },
          { participantId: 'hannah', quantity: 2 },
        ],
      },
    ],
    serviceChargeCents: 0,
    gstCents: 0,
    totalCents: $(9),
  };

  const result = calculateBill(bill);
  assert.equal(result.reconciled, true);

  const byId = Object.fromEntries(result.shares.map((s) => [s.participantId, s]));
  assert.equal(byId.rachel.totalCents, $(3)); // 1/3 of $9
  assert.equal(byId.hannah.totalCents, $(6)); // 2/3 of $9
});

// --- Trust invariant: a bill that doesn't reconcile must be refused ---
test('Invariant: an unreconciled bill blocks the whole settlement', () => {
  const badBill = {
    id: 'bad-bill',
    payerId: 'alice',
    participantIds: ['alice', 'bob'],
    items: [
      { id: 'x', totalCents: $(50), allocations: [{ participantId: 'alice' }] },
      { id: 'y', totalCents: $(50), allocations: [{ participantId: 'bob' }] },
    ],
    serviceChargeCents: 0,
    gstCents: 0,
    totalCents: $(105), // wrong on purpose - doesn't match items ($100)
  };

  const single = calculateBill(badBill);
  assert.equal(single.reconciled, false);

  const settlement = calculateSettlement([badBill], ['alice', 'bob']);
  assert.equal(settlement.ok, false);
  assert.equal(settlement.reason, 'unreconciled_bills');
  assert.deepEqual(settlement.unreconciledBillIds, ['bad-bill']);
});

// --- Edge case: an item with no allocation must block finalisation ---
test('Edge case: an unallocated item throws rather than silently guessing', () => {
  const bill = {
    id: 'unassigned',
    payerId: 'alice',
    participantIds: ['alice', 'bob'],
    items: [{ id: 'mystery-item', totalCents: $(20), allocations: [] }],
    serviceChargeCents: 0,
    gstCents: 0,
    totalCents: $(20),
  };

  assert.throws(() => calculateBill(bill), /no allocation/);
});

// --- Edge case: zero item subtotal (e.g. a bill with only a flat fee) ---
test('Edge case: zero pre-tax subtotal falls back to an equal split, not divide-by-zero', () => {
  const bill = {
    id: 'flat-fee-only',
    payerId: 'alice',
    participantIds: ['alice', 'bob'],
    items: [], // no priced items at all
    serviceChargeCents: $(10),
    gstCents: 0,
    totalCents: $(10),
  };

  const result = calculateBill(bill);
  assert.equal(result.reconciled, true);

  const byId = Object.fromEntries(result.shares.map((s) => [s.participantId, s]));
  // Alice is first in participantIds, so she wins the tie-break and gets
  // the rounding residual (irrelevant here since $10/2 is exact, but the
  // point is it doesn't throw and it reconciles).
  assert.equal(byId.alice.serviceChargeCents, $(5));
  assert.equal(byId.bob.serviceChargeCents, $(5));
});

// --- Tie-break determinism check on the settlement matcher itself ---
test('computeTransfers: ties are broken by creation order via stable sort', () => {
  const balances = [
    { participantId: 'a', netCents: $(-20) },
    { participantId: 'b', netCents: $(-20) }, // ties with 'a'
    { participantId: 'c', netCents: $(40) },
  ];

  const transfers = computeTransfers(balances);
  // 'a' was listed first among the tied debtors, so it should be matched
  // first against the sole creditor.
  assert.deepEqual(transfers, [
    { from: 'a', to: 'c', amountCents: $(20) },
    { from: 'b', to: 'c', amountCents: $(20) },
  ]);
});
