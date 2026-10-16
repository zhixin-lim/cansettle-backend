import { createHash, timingSafeEqual } from 'node:crypto';
import { createTelegram } from './telegram.mjs';
import { readReceipt } from './receiptReader.mjs';
import { createBotHandler } from './handler.mjs';

/**
 * Telegram sends this secret in a header with every webhook call, so nobody
 * else can post fake updates to the endpoint. It is derived from the bot token,
 * so there is no extra variable to set.
 */
export function webhookSecret(token) {
  return createHash('sha256').update(`cansettle:${token}`).digest('hex');
}

/**
 * Adds POST /telegram/webhook to the app when TELEGRAM_BOT_TOKEN is set.
 * Without a token this does nothing and the API runs exactly as before.
 * Everything outside (Telegram, Gemini, the handler) can be swapped for tests.
 */
export function mountBot(app, { store, env = process.env, tg, reader = readReceipt, handler } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { enabled: false };

  const secret = webhookSecret(token);
  const telegram = tg ?? createTelegram({ token });
  const bot =
    handler ??
    createBotHandler({
      tg: telegram,
      readReceipt: reader,
      store,
      miniAppUrl: env.MINI_APP_URL || undefined,
    });

  app.post('/telegram/webhook', (req, res) => {
    const given = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') ?? ''));
    const expected = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return res.sendStatus(401);
    }
    // Answer Telegram straight away (reading a receipt can take a while);
    // the handler finishes in the background and never throws.
    res.sendStatus(200);
    bot.handleUpdate(req.body);
  });

  /** Tells Telegram where to send updates. Run once at startup. */
  async function registerWebhook() {
    const base = env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);
    if (!base) {
      console.warn('Telegram bot is on but there is no PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN), so the webhook was not registered.');
      return false;
    }
    await telegram.setWebhook({ url: `${base.replace(/\/+$/, '')}/telegram/webhook`, secret });
    console.log('Telegram webhook registered');
    return true;
  }

  return { enabled: true, registerWebhook };
}
