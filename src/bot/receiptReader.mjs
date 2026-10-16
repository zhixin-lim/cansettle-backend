// Reads a receipt photo with Gemini and turns it into plain structured data.
//
// The split of jobs is deliberate: the AI only READS what is printed (items,
// charges, total). This code converts dollars to cents and checks the result.
// Nothing here works out who owes what, and nothing is trusted blindly: the
// person confirms what was read before it goes any further.

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
{"isReceipt": boolean, "merchant": string or null, "items": [{"name": string, "quantity": integer, "lineTotal": number}], "serviceCharge": number or null, "gst": number or null, "total": number or null}

Rules:
- Amounts are plain decimal numbers in dollars, exactly as printed (no currency symbols).
- lineTotal is the total price printed for that line (quantity x unit price). quantity is 1 if not shown.
- List every purchased item once. Keep names as printed, tidied up.
- Discounts, vouchers and promotions are items with a NEGATIVE lineTotal.
- Do NOT list service charge, GST, subtotal, total, rounding, payment method or change as items.
- serviceCharge and gst are the amounts printed for those lines (null if the receipt has none).
- total is the final amount payable.
- Never include card numbers, cardholder names, phone numbers or addresses anywhere.
- If a number is unclear, use null rather than guessing.
- If the image is not a receipt, return {"isReceipt": false, "merchant": null, "items": [], "serviceCharge": null, "gst": null, "total": null}.`;

/** Dollars (as the AI read them) to whole cents. */
function toCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * Validates and cleans what the AI returned. Throws ReceiptReadError if it
 * isn't a receipt or nothing usable was read.
 * @returns {{ merchant: string|null, items: {name: string, qty: number, totalCents: number}[],
 *             serviceChargeCents: number, gstCents: number, totalCents: number }}
 */
export function normalizeReceipt(raw) {
  if (!raw || typeof raw !== 'object') throw new ReceiptReadError('UNREADABLE');
  if (raw.isReceipt === false) throw new ReceiptReadError('NOT_A_RECEIPT');

  const items = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, MAX_NAME_LENGTH) : '';
    const totalCents = toCents(item?.lineTotal);
    if (!name || totalCents === null || totalCents === 0) continue;
    const qty = Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    items.push({ name, qty, totalCents });
    if (items.length >= MAX_ITEMS) break;
  }
  if (items.length === 0) throw new ReceiptReadError('UNREADABLE');

  const serviceChargeCents = Math.max(0, toCents(raw.serviceCharge) ?? 0);
  const gstCents = Math.max(0, toCents(raw.gst) ?? 0);
  const itemsTotal = items.reduce((s, i) => s + i.totalCents, 0);
  // If the printed total couldn't be read, fall back to what the lines add up to.
  const printedTotal = toCents(raw.total);
  const totalCents = printedTotal !== null && printedTotal > 0 ? printedTotal : itemsTotal + serviceChargeCents + gstCents;

  const merchant = typeof raw.merchant === 'string' && raw.merchant.trim() ? raw.merchant.trim().slice(0, MAX_NAME_LENGTH) : null;
  return { merchant, items, serviceChargeCents, gstCents, totalCents };
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
 * Sends the photo to Gemini and returns a normalised receipt.
 * Error codes: BUSY (rate limit / outage / timeout), CONFIG (bad key or model:
 * a problem for the owner, not the user), UNREADABLE, NOT_A_RECEIPT.
 */
export async function readReceipt({
  bytes,
  mimeType,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  fetchImpl = fetch,
  timeoutMs = 45_000,
}) {
  if (!apiKey) throw new ReceiptReadError('CONFIG', 'GEMINI_API_KEY is not set');

  let res;
  try {
    res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString('base64') } },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ReceiptReadError('BUSY', 'The reader could not be reached or timed out');
  }

  if (res.status === 429 || res.status >= 500) throw new ReceiptReadError('BUSY', `Gemini returned ${res.status}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ReceiptReadError('CONFIG', `Gemini returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => null);
  if (data?.promptFeedback?.blockReason) throw new ReceiptReadError('UNREADABLE', 'The image was blocked');
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (!text) throw new ReceiptReadError('UNREADABLE', 'The reader returned nothing');

  return normalizeReceipt(parseModelJson(text));
}
