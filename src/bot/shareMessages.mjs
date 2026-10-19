// The messages a person forwards after settling: one for the group chat, and
// one per person who owes. They are sent as Telegram HTML (real bold, line
// breaks, tap-to-copy PayNow numbers), so they arrive already structured and
// nobody has to copy and paste anything.
//
// Every figure comes from the settlement engine's result. Nothing here does any
// arithmetic of its own beyond adding up numbers the engine already produced.
// All text that came from outside (shop names, item names, people's names)
// goes through esc().

import { formatCents } from '../engine/money.mjs';
import { esc } from './messages.mjs';

const MAX_ITEMS_PER_PERSON = 25; // keeps a big bill under Telegram's 4096-character limit

const nameOf = (session, id) => session.participants.find((p) => p.id === id)?.name ?? 'Someone';
const billLabel = (bill) => bill.name?.trim() || 'Bill';

function billsTitle(session) {
  const names = [...new Set(session.bills.map((b) => b.name?.trim()).filter(Boolean))];
  if (names.length > 0) return names.join(' + ');
  return session.bills.length > 1 ? 'the bills' : 'the bill';
}

/** "PayNow 90487510" with the number in <code> so one tap copies it. */
const paynowTag = (number) => (number ? `PayNow <code>${esc(number)}</code>` : '');

/** What one person had, per bill, straight from the engine's per-item shares. */
function personBills(session, settlement, participantId) {
  const out = [];
  for (const result of settlement.billResults) {
    const share = result.shares.find((s) => s.participantId === participantId);
    if (!share || share.totalCents === 0) continue;
    const bill = session.bills.find((b) => b.id === result.billId);
    const lines = result.itemShares
      .filter((x) => x.participantId === participantId && x.cents !== 0)
      .map((x) => {
        const item = bill?.items.find((i) => i.id === x.itemId);
        return { name: item?.name?.trim() || 'Item', sharedWays: item?.allocations?.length ?? 1, cents: x.cents };
      });
    out.push({ bill, lines, share });
  }
  return out;
}

/** One message for the group chat: who had what (names only) and who pays whom. */
export function groupMessageHtml(session, settlement, { paynow = {} } = {}) {
  const out = [];

  for (const bill of session.bills) {
    const payer = bill.payerId ? nameOf(session, bill.payerId) : 'Someone';
    out.push(`🧾 <b>${esc(billLabel(bill))}</b> — ${formatCents(bill.totalCents)}`, `<i>paid by ${esc(payer)}</i>`);
  }
  if (session.bills.length > 1) {
    const grand = settlement.billResults.reduce((sum, r) => sum + r.expectedTotalCents, 0);
    out.push('', `<b>Total — ${formatCents(grand)}</b>`);
  }

  for (const balance of settlement.balances) {
    if (balance.shareCents === 0) continue;
    const names = personBills(session, settlement, balance.participantId).flatMap((v) => v.lines.map((l) => l.name));
    const shown = names.slice(0, MAX_ITEMS_PER_PERSON).map(esc);
    if (names.length > MAX_ITEMS_PER_PERSON) shown.push(`…and ${names.length - MAX_ITEMS_PER_PERSON} more`);
    out.push('', `👤 <b>${esc(nameOf(session, balance.participantId))}</b> — ${formatCents(balance.shareCents)}`);
    if (shown.length > 0) out.push(shown.join(', '));
  }

  if (session.bills.some((b) => (b.discountCents ?? 0) > 0 || b.serviceChargeCents > 0 || b.gstCents > 0)) {
    out.push('', 'Service charge, GST and any discount are already included in each amount.');
  }

  out.push('');
  if (settlement.transfers.length === 0) {
    out.push('All square already, nobody owes anybody 🎉');
  } else {
    out.push('💸 <b>Who pays whom</b>');
    for (const t of settlement.transfers) {
      const pay = paynowTag(paynow[t.to]);
      out.push(`${esc(nameOf(session, t.from))} → ${esc(nameOf(session, t.to))} <b>${formatCents(t.amountCents)}</b>${pay ? ` · ${pay}` : ''}`);
    }
  }
  out.push('', 'Check your items above 👆 React 🫡 once paid.');
  return out.join('\n');
}

/** A message for one person: what they had, what they owe, who to pay. Null if they owe nothing. */
export function personalMessageHtml(session, settlement, participantId, { paynow = {} } = {}) {
  const outgoing = settlement.transfers.filter((t) => t.from === participantId);
  if (outgoing.length === 0) return null;

  const me = esc(nameOf(session, participantId));
  const owed = outgoing.reduce((sum, t) => sum + t.amountCents, 0);
  const first = outgoing[0];
  const out = [
    outgoing.length === 1
      ? `Eh <b>${me}</b>, you owe <b>${esc(nameOf(session, first.to))} ${formatCents(owed)}</b> for ${esc(billsTitle(session))} 🧾`
      : `Eh <b>${me}</b>, you owe <b>${formatCents(owed)}</b> for ${esc(billsTitle(session))} 🧾`,
  ];

  const bills = personBills(session, settlement, participantId);
  let discount = 0;
  let serviceCharge = 0;
  let gst = 0;
  for (const { bill, lines, share } of bills) {
    out.push('');
    if (bills.length > 1 && bill) out.push(`<b>${esc(billLabel(bill))}</b>`);
    for (const l of lines.slice(0, MAX_ITEMS_PER_PERSON)) {
      out.push(`${esc(l.name)}${l.sharedWays > 1 ? ` (shared ${l.sharedWays} ways)` : ''} — ${formatCents(l.cents)}`);
    }
    if (lines.length > MAX_ITEMS_PER_PERSON) out.push(`…and ${lines.length - MAX_ITEMS_PER_PERSON} more`);
    discount += share.discountCents ?? 0;
    serviceCharge += share.serviceChargeCents;
    gst += share.gstCents;
  }
  if (discount > 0) out.push(`Discount — -${formatCents(discount)}`);
  if (serviceCharge > 0 && gst > 0) out.push(`Service charge + GST — ${formatCents(serviceCharge + gst)}`);
  else if (serviceCharge > 0) out.push(`Service charge — ${formatCents(serviceCharge)}`);
  else if (gst > 0) out.push(`GST — ${formatCents(gst)}`);

  const balance = settlement.balances.find((b) => b.participantId === participantId);
  if (balance) {
    out.push('', `Your share — ${formatCents(balance.shareCents)}`);
    if (balance.paidCents > 0) out.push(`Already paid — ${formatCents(balance.paidCents)}`);
    out.push(`<b>You owe — ${formatCents(owed)}</b>`);
  }

  out.push('');
  if (outgoing.length === 1) {
    const pay = paynowTag(paynow[first.to]);
    if (pay) out.push(`${pay} to ${esc(nameOf(session, first.to))}`);
  } else {
    out.push('Please pay:');
    for (const t of outgoing) {
      const pay = paynowTag(paynow[t.to]);
      out.push(`${esc(nameOf(session, t.to))} <b>${formatCents(t.amountCents)}</b>${pay ? ` · ${pay}` : ''}`);
    }
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
