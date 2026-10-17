// Every message the CanSettle bot sends lives here, so the voice stays
// consistent and wording can be tweaked in one place.
//
// Bot messages are sent with parse_mode "HTML", so <b> works properly here
// (unlike pasted text, which Telegram shows literally). Anything that comes
// from outside - shop names and item names read off a receipt - MUST go
// through esc(), otherwise a stray "<" or "&" makes Telegram reject the message.
//
// Voice: same as the app. Short punchy headline, one plain sentence saying
// what to do. Singlish stays in the headline/asides, never in the instruction.

import { formatCents } from '../engine/money.mjs';

export const PARSE_MODE = 'HTML';

export function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MAX_ITEM_LINES = 40; // keeps long receipts under Telegram's 4096-character limit

/** Button labels, kept next to the messages that use them. */
export const buttons = {
  looksRight: 'Looks right ✅',
  retake: 'Retake photo 📸',
  anotherYes: 'Yes, another receipt',
  anotherNo: "That's all",
  openApp: 'Open CanSettle',
};

export function welcome() {
  return [
    "<b>Hi, I'm CanSettle 🧾</b>",
    'Got a bill to settle? Send me a photo of the receipt and I will read it for you.',
    '',
    "Then you check what I read, open the app, and say who had what. I'll work out exactly who pays whom, GST and service charge included.",
    '',
    "Heads up: Google's Gemini AI reads your photo. /help explains what that means.",
    '',
    'Send the receipt photo whenever you are ready 📸',
  ].join('\n');
}

export function help() {
  return [
    '<b>How CanSettle works</b>',
    '1. Send a photo of the receipt (one photo per receipt).',
    '2. Check the items I read. Wrong? You can fix them in the app.',
    '3. Add more receipts if there are any.',
    '4. Open the app and say who had what.',
    '',
    '<b>About your receipt</b>',
    "Google's Gemini AI reads the photo to pull out the items. I do not keep the photo, but on Google's free plan Google may use what it receives to improve its products, and people there may read it.",
    'So crop out card numbers and names first, or skip the photo and add the bill by hand in the app.',
    '',
    'Nothing is permanent: a settlement is cleared after 24 hours. No accounts.',
    '',
    '/start — start a new settlement',
    '/cancel — drop the current one',
  ].join('\n');
}

export function reading() {
  return 'Reading your receipt… 🧾';
}

/**
 * The review message. `receipt` is what the reader extracted:
 * { merchant, items: [{ name, qty, totalCents }], serviceChargeCents, gstCents, totalCents }
 */
export function receiptReview(receipt, { number = 1 } = {}) {
  const items = receipt.items ?? [];
  const sc = receipt.serviceChargeCents ?? 0;
  const gst = receipt.gstCents ?? 0;
  const itemsTotal = items.reduce((s, i) => s + i.totalCents, 0);

  const lines = [`<b>Receipt ${number}${receipt.merchant ? ` — ${esc(receipt.merchant)}` : ''}</b>`, ''];

  for (const item of items.slice(0, MAX_ITEM_LINES)) {
    const qty = (item.qty ?? 1) > 1 ? `${item.qty}x ` : '';
    lines.push(`${qty}${esc(item.name)} — ${formatCents(item.totalCents)}`);
  }
  if (items.length > MAX_ITEM_LINES) lines.push(`…and ${items.length - MAX_ITEM_LINES} more items`);

  lines.push('');
  // Discounts are already taken off the item prices above, so say so: otherwise
  // a price lower than the receipt's looks like a misread.
  for (const d of receipt.discounts ?? []) {
    lines.push(`${esc(d.name)} — -${formatCents(d.cents)} (already taken off the items above)`);
  }
  if (sc > 0) lines.push(`Service charge — ${formatCents(sc)}`);
  else if ((receipt.serviceChargeIncludedCents ?? 0) > 0) {
    lines.push(`Service charge — ${formatCents(receipt.serviceChargeIncludedCents)} (already in the prices)`);
  }
  if (gst > 0) lines.push(`GST — ${formatCents(gst)}`);
  else if ((receipt.gstIncludedCents ?? 0) > 0) {
    lines.push(`GST — ${formatCents(receipt.gstIncludedCents)} (already in the prices)`);
  }
  lines.push(`<b>Total — ${formatCents(receipt.totalCents)}</b>`);

  const gap = receipt.totalCents - (itemsTotal + sc + gst);
  if (gap !== 0) {
    lines.push(
      '',
      `⚠️ Alamak, the items and charges add up to ${formatCents(itemsTotal + sc + gst)}, not ${formatCents(receipt.totalCents)}. I may have misread something. You can fix it in the app.`,
    );
  }

  lines.push('', 'Does this look right?');
  return lines.join('\n');
}

export function receiptAdded(receipt) {
  const name = receipt.merchant ? esc(receipt.merchant) : 'That receipt';
  return `Got it ✅ ${name} — ${formatCents(receipt.totalCents)}`;
}

export function anotherReceipt(count) {
  return `${count} receipt${count === 1 ? '' : 's'} so far. Got another one from this outing?`;
}

export function readyToOpen({ receiptCount, totalCents }) {
  return [
    `<b>All set 🎉</b>`,
    `${receiptCount} receipt${receiptCount === 1 ? '' : 's'}, ${formatCents(totalCents)} in total.`,
    'Tap below and say who had what 👇',
  ].join('\n');
}

export function askForPhoto() {
  return 'No problem. Send the receipt photo again 📸';
}

export function nextReceipt() {
  return 'Send the next receipt 📸';
}

export function cancelled() {
  return 'Okay, dropped. Send a new receipt photo whenever you want to start again.';
}

export function nothingToCancel() {
  return 'Nothing to cancel right now. Send a receipt photo to get started 📸';
}

/* ----------------------------------------------------------------- problems */

export function cantRead() {
  return "Alamak, I couldn't read that one. Try a clearer photo: flat, well lit, with the whole receipt in the frame.";
}

export function notAReceipt() {
  return "Hmm, that doesn't look like a receipt to me. Send a photo of the receipt itself 📸";
}

export function busy() {
  return "I'm a bit busy right now. Try again in a minute, or add the bill by hand in the app.";
}

export function sendAPhoto() {
  return 'Send me a photo of the receipt 📸';
}

export function tooMany() {
  return "Whoa, that's a lot of receipts in a short time. Give me a few minutes, then send the next one.";
}

export function staleButton() {
  return "That button is from an older message. Send a receipt photo to start again 📸";
}

export function privateOnly() {
  return 'Message me directly to settle a bill, I only work in private chats.';
}

export function sessionGone() {
  return 'That settlement has expired (we only keep them for 24 hours). Send a receipt photo to start a new one.';
}
