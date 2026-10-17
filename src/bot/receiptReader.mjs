// Reads a receipt photo with Gemini and turns it into plain structured data.
//
// The split of jobs is deliberate: the AI only READS what is printed (items,
// charges, total). This code converts dollars to cents and checks the result.
// Nothing here works out who owes what, and nothing is trusted blindly: the
// person confirms what was read before it goes any further.

import { allocateProportional } from '../engine/allocation.mjs';

export class ReceiptReadError extends Error {
  /** code: NOT_A_RECEIPT | UNREADABLE | BUSY | CONFIG */
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

const MAX_ITEMS = 100;
const MAX_NAME_LENGTH = 80;

export const PROMPT = `You read photos of receipts (mostly restaurants and shops in Singapore).
Return ONLY a JSON object, with no other text, in exactly this shape:
{"isReceipt": boolean, "merchant": string or null, "items": [{"name": string, "quantity": integer, "lineTotal": number}], "discounts": [{"name": string, "amount": number, "appliesTo": string or null}], "serviceCharge": number or null, "gst": number or null, "gstIncluded": boolean, "serviceChargeIncluded": boolean, "total": number or null}

Rules:
- Amounts are plain decimal numbers in dollars, exactly as printed (no currency symbols).
- items are purchased things with a POSITIVE price. lineTotal is the total price printed for that line (quantity x unit price). quantity is 1 if not shown. List every item once, names as printed but tidied up.
- Discounts, vouchers, promotions and payment-app discounts go in discounts, NOT in items. amount is POSITIVE (a printed "-0.68" is 0.68). appliesTo is the exact name of the item the discount clearly belongs to, or null if it applies to the whole bill.
- Do NOT list service charge, GST, subtotal, total, rounding, payment method or change as items.
- serviceCharge and gst are the amounts printed for those lines (null if the receipt has none).
- gstIncluded is true ONLY if the receipt says GST is already included in the prices (for example "Incl. GST", "GST inclusive", "prices include GST", "GST included: 0.51"). It is false if GST is charged on top of the items. serviceChargeIncluded works the same way for service charge. Still report the printed amounts.
- total is the final amount payable.
- Never include card numbers, cardholder names, phone numbers or addresses anywhere.
- If a number is unclear, use null rather than guessing.
- If the image is not a receipt, return {"isReceipt": false, "merchant": null, "items": [], "discounts": [], "serviceCharge": null, "gst": null, "gstIncluded": false, "serviceChargeIncluded": false, "total": null}.`;

/** Dollars (as the AI read them) to whole cents. */
function toCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when two item names are plainly the same thing ("Wanton noodle" vs "Wanton Noodles"). */
function sameItem(a, b) {
  const x = squash(a);
  const y = squash(b);
  return x.length >= 3 && y.length >= 3 && (x === y || x.includes(y) || y.includes(x));
}

/**
 * Takes each discount off the items it belongs to, so the app only ever sees
 * ordinary positive prices. A discount that names an item comes off that item;
 * any other discount is spread across all the items in proportion to their
 * price (exact to the cent, using the same rounding rule as the settlement
 * engine). Items discounted down to nothing are dropped.
 */
function foldDiscounts(items, discounts) {
  const applied = [];
  for (const discount of discounts) {
    const available = items.reduce((sum, i) => sum + i.totalCents, 0);
    let remaining = Math.min(discount.cents, available);
    if (remaining <= 0) continue;
    applied.push({ name: discount.name, cents: remaining });

    const target = discount.appliesTo ? items.find((i) => i.totalCents > 0 && sameItem(i.name, discount.appliesTo)) : null;
    if (target) {
      const taken = Math.min(remaining, target.totalCents);
      target.totalCents -= taken;
      remaining -= taken;
    }
    if (remaining > 0) {
      const live = items.filter((i) => i.totalCents > 0);
      const shares = allocateProportional(remaining, live.map((i, index) => ({ id: index, weight: i.totalCents })));
      live.forEach((item, index) => {
        item.totalCents -= shares[index].amountCents;
      });
    }
  }
  return { items: items.filter((i) => i.totalCents > 0), applied };
}

/**
 * Validates and cleans what the AI returned, so everything downstream can rely
 * on it. Throws ReceiptReadError if it isn't a receipt or nothing usable was read.
 *
 * Returns { merchant, items, discounts, serviceChargeCents, gstCents,
 *           serviceChargeIncludedCents, gstIncludedCents, totalCents } where
 *  - items all have positive prices, with discounts already taken off;
 *  - serviceChargeCents and gstCents are only charges ADDED on top of the items,
 *    so items + charges adds up to the total. A charge the receipt says is
 *    "included" in the prices is reported separately (…IncludedCents) and not added.
 */
export function normalizeReceipt(raw) {
  if (!raw || typeof raw !== 'object') throw new ReceiptReadError('UNREADABLE');
  if (raw.isReceipt === false) throw new ReceiptReadError('NOT_A_RECEIPT');

  let items = [];
  const discounts = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    const cents = toCents(item?.lineTotal);
    if (!name || cents === null || cents === 0) continue;
    if (cents < 0) {
      // A discount listed as an item despite the instructions: treat it as a discount.
      discounts.push({ name, cents: -cents, appliesTo: null });
      continue;
    }
    const qty = Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    items.push({ name, qty, totalCents: cents });
    if (items.length >= MAX_ITEMS) break;
  }
  for (const d of Array.isArray(raw.discounts) ? raw.discounts : []) {
    const cents = toCents(d?.amount);
    if (cents === null || cents === 0) continue;
    const name = typeof d?.name === 'string' && d.name.trim() ? d.name.trim().slice(0, MAX_NAME_LENGTH) : 'Discount';
    const appliesTo = typeof d?.appliesTo === 'string' && d.appliesTo.trim() ? d.appliesTo.trim() : null;
    discounts.push({ name, cents: Math.abs(cents), appliesTo });
  }
  if (items.length === 0) throw new ReceiptReadError('UNREADABLE');

  const folded = foldDiscounts(items, discounts);
  items = folded.items;
  if (items.length === 0) throw new ReceiptReadError('UNREADABLE');

  let serviceChargeCents = Math.max(0, toCents(raw.serviceCharge) ?? 0);
  let gstCents = Math.max(0, toCents(raw.gst) ?? 0);
  let serviceChargeIncludedCents = 0;
  let gstIncludedCents = 0;

  const base = items.reduce((s, i) => s + i.totalCents, 0);
  const printed = toCents(raw.total);
  const hasPrinted = printed !== null && printed > 0;
  const reconciles = () => hasPrinted && base + serviceChargeCents + gstCents === printed;

  // Charges the receipt says are already inside the prices must not be added again.
  // The arithmetic has the last word: if items + charges already match the printed
  // total, nothing is "included", whatever the AI said.
  if (!reconciles()) {
    if (hasPrinted && base === printed && (serviceChargeCents > 0 || gstCents > 0)) {
      [serviceChargeIncludedCents, gstIncludedCents] = [serviceChargeCents, gstCents];
      serviceChargeCents = 0;
      gstCents = 0;
    } else {
      const gstIsInside = gstCents > 0 && (raw.gstIncluded === true || (hasPrinted && base + serviceChargeCents === printed));
      if (gstIsInside) {
        gstIncludedCents = gstCents;
        gstCents = 0;
      }
      const scIsInside =
        !reconciles() && serviceChargeCents > 0 && (raw.serviceChargeIncluded === true || (hasPrinted && base + gstCents === printed));
      if (scIsInside) {
        serviceChargeIncludedCents = serviceChargeCents;
        serviceChargeCents = 0;
      }
    }
  }

  // If the printed total couldn't be read, fall back to what the lines add up to.
  const totalCents = hasPrinted ? printed : base + serviceChargeCents + gstCents;
  const merchant = typeof raw.merchant === 'string' && raw.merchant.trim() ? raw.merchant.trim().slice(0, MAX_NAME_LENGTH) : null;
  return {
    merchant,
    items,
    discounts: folded.applied,
    serviceChargeCents,
    gstCents,
    serviceChargeIncludedCents,
    gstIncludedCents,
    totalCents,
  };
}

/** Pulls the JSON object out of the model's text, tolerating code fences. */
export function parseModelJson(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ReceiptReadError('UNREADABLE', 'The reader did not return valid JSON');
  }
}

/**
 * Google retires Gemini models on a schedule (gemini-2.5-flash is scheduled to
 * shut down on 16 October 2026), so the reader tries a list of models instead
 * of trusting one name. Set GEMINI_MODEL (one name, or a comma-separated list)
 * to override this without changing code.
 */
export const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3-flash-preview'];

export function modelsFromEnv(env = process.env) {
  const list = String(env.GEMINI_MODEL ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MODELS;
}

// The model that worked last time is tried first, so a retired model costs
// one wasted call per restart instead of one per receipt.
let lastGoodModel = null;
export function _resetModelMemory() {
  lastGoodModel = null;
}

/** Statuses meaning "this model isn't usable for you right now, try the next one". */
const tryNextModel = (status) => status === 403 || status === 404 || status === 429 || status >= 500;

/**
 * Sends the photo to Gemini and returns a normalised receipt.
 * Error codes: BUSY (rate limit / outage / timeout), CONFIG (bad key, or no
 * model worked and none was merely busy: a problem for the owner, not the
 * user), UNREADABLE, NOT_A_RECEIPT. The message lists what each model said,
 * so the server log shows exactly what to fix.
 */
export async function readReceipt({
  bytes,
  mimeType,
  apiKey = process.env.GEMINI_API_KEY,
  models = modelsFromEnv(),
  fetchImpl = fetch,
  timeoutMs = 45_000,
}) {
  if (!apiKey) throw new ReceiptReadError('CONFIG', 'GEMINI_API_KEY is not set');

  const order = lastGoodModel && models.includes(lastGoodModel) ? [lastGoodModel, ...models.filter((m) => m !== lastGoodModel)] : models;
  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString('base64') } },
        ],
      },
    ],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });

  const failures = [];
  for (const model of order) {
    let res;
    try {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Unreachable or timed out: another model won't help, and waiting again would be slow.
      throw new ReceiptReadError('BUSY', `Gemini could not be reached (${model})`);
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.promptFeedback?.blockReason) throw new ReceiptReadError('UNREADABLE', 'The image was blocked');
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!text) throw new ReceiptReadError('UNREADABLE', 'The reader returned nothing');
      lastGoodModel = model;
      return normalizeReceipt(parseModelJson(text));
    }

    const detail = String(await Promise.resolve().then(() => res.text()).catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    if (tryNextModel(res.status)) {
      failures.push(`${model}: ${res.status} ${detail}`.trim());
      continue;
    }
    // e.g. 400 "API key not valid": every model would fail the same way.
    throw new ReceiptReadError('CONFIG', `Gemini returned ${res.status} for ${model}: ${detail}`);
  }

  const justBusy = failures.some((f) => / (429|5\d\d)( |$)/.test(f));
  throw new ReceiptReadError(justBusy ? 'BUSY' : 'CONFIG', `No Gemini model worked. ${failures.join(' | ')}`);
}
