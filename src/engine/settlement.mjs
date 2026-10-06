import { calculateBill } from './bill.mjs';

/**
 * Calculates each participant's session-wide net balance:
 *   net = total they paid across all bills - total of their calculated shares
 * Positive = they should receive money. Negative = they owe money.
 *
 * Refuses to produce balances if any bill fails to reconcile - per the
 * state invariant, nothing gets finalised until every bill is accounted for.
 *
 * @param {import('./bill.mjs').Bill[]} bills
 * @param {string[]} participantIds - session-wide, in creation order
 */
export function calculateNetBalances(bills, participantIds) {
  const billResults = bills.map(calculateBill);

  const unreconciled = billResults.filter((r) => !r.reconciled);
  if (unreconciled.length > 0) {
    return {
      ok: false,
      reason: 'unreconciled_bills',
      unreconciledBillIds: unreconciled.map((r) => r.billId),
      billResults,
    };
  }

  const paid = new Map(participantIds.map((id) => [id, 0]));
  const share = new Map(participantIds.map((id) => [id, 0]));

  for (const bill of bills) {
    paid.set(bill.payerId, (paid.get(bill.payerId) ?? 0) + bill.totalCents);
  }
  for (const result of billResults) {
    for (const s of result.shares) {
      share.set(s.participantId, (share.get(s.participantId) ?? 0) + s.totalCents);
    }
  }

  const balances = participantIds.map((id) => ({
    participantId: id,
    paidCents: paid.get(id) ?? 0,
    shareCents: share.get(id) ?? 0,
    netCents: (paid.get(id) ?? 0) - (share.get(id) ?? 0),
  }));

  return { ok: true, billResults, balances };
}

/**
 * Deterministic global settlement matching:
 *  - sort debtors (net < 0) descending by amount owed, ties broken by
 *    original (creation) order
 *  - sort creditors (net > 0) descending by amount owed, same tie-break
 *  - repeatedly match the head debtor with the head creditor, transfer
 *    min(remaining balances), drop whichever side hits zero, continue
 *  - no re-sorting mid-process: each transfer zeroes at least one party,
 *    which guarantees at most n-1 transfers and full determinism from the
 *    initial sort alone
 *
 * @param {{participantId: string, netCents: number}[]} balances
 * @returns {{from: string, to: string, amountCents: number}[]}
 */
export function computeTransfers(balances) {
  const total = balances.reduce((s, b) => s + b.netCents, 0);
  if (total !== 0) {
    throw new Error(`Balances must sum to 0 before settling (got ${total} cents)`);
  }

  // Array.prototype.sort is a stable sort in modern JS engines, so equal
  // balances keep the relative order they arrived in (= creation order),
  // which satisfies the tie-break rule without extra code.
  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ id: b.participantId, remaining: -b.netCents }))
    .sort((a, b) => b.remaining - a.remaining);

  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ id: b.participantId, remaining: b.netCents }))
    .sort((a, b) => b.remaining - a.remaining);

  const transfers = [];
  let di = 0;
  let ci = 0;

  while (di < debtors.length && ci < creditors.length) {
    const d = debtors[di];
    const c = creditors[ci];
    const amountCents = Math.min(d.remaining, c.remaining);

    if (amountCents > 0) {
      transfers.push({ from: d.id, to: c.id, amountCents });
      d.remaining -= amountCents;
      c.remaining -= amountCents;
    }

    if (d.remaining === 0) di++;
    if (c.remaining === 0) ci++;
  }

  return transfers;
}

/**
 * Convenience wrapper: bills -> full settlement (balances + transfers),
 * or a refusal if any bill doesn't reconcile.
 */
export function calculateSettlement(bills, participantIds) {
  const result = calculateNetBalances(bills, participantIds);
  if (!result.ok) return result;

  return {
    ok: true,
    billResults: result.billResults,
    balances: result.balances,
    transfers: computeTransfers(result.balances),
  };
}
