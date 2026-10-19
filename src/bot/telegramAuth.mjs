import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks the signed identity data Telegram hands to a Mini App (`initData`),
 * so the backend knows which Telegram user is really calling. Without this,
 * anyone could ask the bot to send messages to any chat.
 * See: "Validating data received via the Mini App" in Telegram's docs.
 *
 * Returns { user, authDate } if the data is genuine and recent, otherwise null.
 */
export function validateInitData(initData, botToken, { maxAgeSeconds = 24 * 60 * 60, now = () => Date.now() } = {}) {
  if (typeof initData !== 'string' || !initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const given = Buffer.from(hash, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (now() / 1000 - authDate > maxAgeSeconds) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') ?? 'null');
  } catch {
    return null;
  }
  if (!user || !Number.isInteger(user.id)) return null;
  return { user, authDate };
}
