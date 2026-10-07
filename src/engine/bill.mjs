import { allocateProportional } from './allocation.mjs';

/**
 * @typedef {Object} ItemAllocation
 * @property {string} participantId
 * @property {number} quantity - how many units of this item this person had.
 *   Defaults to 1 if omitted, which gives a plain equal split when every
 *   allocation on an item uses quantity 1. Unequal quantities (e.g. a
 *   shared plate of sushi where Rachel had 1 piece and Hannah had 2) are
 *   supported by giving different quantities - the item's totalCents is
 *   then split proportionally to quantity, using the same rounding-residual
 *   rule as everything else in this engine.
 */

/**
 * @typedef {Object} BillItem
 * @property {string} id
 * @property {number} totalCents - this item's total price (qty * unit price), in cents
 * @property {ItemAllocation[]} allocations - who had this item and how much of it
 */

/**
 * @typedef {Object} Bill
 * @property {string} id
 * @property {string} payerId
 * @property {string[]} participantIds - every participant relevant to this bill, in creation order
 * @property {BillItem[]} items
 * @property {number} serviceChargeCents - printed on the receipt, or 0/manual
 * @property {number} gstCents - printed on the receipt, or 0/manual
 * @property {number} totalCents - printed bill total, the source of truth to reconcile against
 */

/**
 * Splits each item equally among the people it's allocated to (using the same
 * rounding-residual rule as SC/GST), then sums per participant to get each
 * person's pre-tax item subtotal.
 */
function computeItemSubtotals(items, participantIds) {
  const subtotals = new Map(participantIds.map((id) => [id, 0]));

  for (const item of items) {
    if (!item.allocations || item.allocations.length === 0) {
      throw new Error(`Item "${item.id}" has no allocation - bill cannot be finalised`);
    }
    const weights = item.allocations.map((a) => ({ id: a.participantId, weight: a.quantity ?? 1 }));
    const shares = allocateProportional(item.totalCents, weights);
    for (const s of shares) {
      subtotals.set(s.id, (subtotals.get(s.id) ?? 0) + s.amountCents);
    }
  }

  return subtotals;
}

/**
 * Calculates one bill's per-participant shares and checks it reconciles
 * exactly to the printed total. Does not look at any other bill.
 *
 * @param {Bill} bill
 * @returns {{
 *   billId: string,
 *   shares: {participantId: string, itemCents: number, serviceChargeCents: number, gstCents: number, totalCents: number}[],
 *   itemSubtotalCents: number,
 *   reconciledTotalCents: number,
 *   expectedTotalCents: number,
 *   reconciled: boolean,
 * }}
 */
export function calculateBill(bill) {
  const subtotalMap = computeItemSubtotals(bill.items, bill.participantIds);
  const itemSubtotalCents = [...subtotalMap.values()].reduce((a, b) => a + b, 0);

  // Weight for SC/GST allocation = each participant's pre-tax item subtotal.
  const weights = bill.participantIds.map((id) => ({ id, weight: subtotalMap.get(id) ?? 0 }));

  const scAllocations = allocateProportional(bill.serviceChargeCents, weights);
  const gstAllocations = allocateProportional(bill.gstCents, weights);

  const scMap = new Map(scAllocations.map((a) => [a.id, a.amountCents]));
  const gstMap = new Map(gstAllocations.map((a) => [a.id, a.amountCents]));

  const shares = bill.participantIds.map((id) => {
    const itemCents = subtotalMap.get(id) ?? 0;
    const serviceChargeCents = scMap.get(id) ?? 0;
    const gstCents = gstMap.get(id) ?? 0;
    return {
      participantId: id,
      itemCents,
      serviceChargeCents,
      gstCents,
      totalCents: itemCents + serviceChargeCents + gstCents,
    };
  });

  const reconciledTotalCents = shares.reduce((s, x) => s + x.totalCents, 0);
  const reconciled = reconciledTotalCents === bill.totalCents;

  return {
    billId: bill.id,
    shares,
    itemSubtotalCents,
    reconciledTotalCents,
    expectedTotalCents: bill.totalCents,
    reconciled,
  };
}
