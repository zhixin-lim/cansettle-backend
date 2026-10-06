import { calculateSettlement } from './engine/index.mjs';

/**
 * Takes a full session (as returned by store.getSession) and either:
 *  - returns the settlement (balances + transfers), or
 *  - refuses, naming exactly what's still blocking it (unassigned items or
 *    a bill that doesn't reconcile) - never guesses or partially settles.
 */
export function computeSessionSettlement(session) {
  const participantIds = session.participants.map((p) => p.id);

  const unassignedItems = [];
  for (const bill of session.bills) {
    for (const item of bill.items) {
      if (!item.allocatedTo || item.allocatedTo.length === 0) {
        unassignedItems.push({ billId: bill.id, itemId: item.id, name: item.name });
      }
    }
  }
  if (unassignedItems.length > 0) {
    return { ok: false, reason: 'unassigned_items', unassignedItems };
  }

  const engineBills = session.bills.map((bill) => ({
    id: bill.id,
    payerId: bill.payerId,
    participantIds,
    items: bill.items.map((item) => ({
      id: item.id,
      totalCents: item.totalCents,
      allocatedTo: item.allocatedTo,
    })),
    serviceChargeCents: bill.serviceChargeCents,
    gstCents: bill.gstCents,
    totalCents: bill.totalCents,
  }));

  return calculateSettlement(engineBills, participantIds);
}
