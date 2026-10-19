import { createHash, timingSafeEqual } from 'node:crypto';
import { createTelegram } from './telegram.mjs';
import { readReceipt } from './receiptReader.mjs';
import { createBotHandler } from './handler.mjs';
import { validateInitData } from './telegramAuth.mjs';
import { groupMessageHtml, personalMessageHtml } from './shareMessages.mjs';
import { computeSessionSettlement } from '../settlementService.mjs';

/**
 * Telegram sends this secret in a header with every webhook call, so nobody
 * else can post fake updates to the endpoint. It is derived from the bot token,
 * so there is no extra variable to set.
 */
export function webhookSecret(token) {
  return createHash('sha256').update(`cansettle:${token}`).digest('hex');
}

/**
 * PayNow numbers arrive with each share request only so they can be written
 * into the message. They are never stored or logged. Anything that doesn't look
 * like a phone number, or isn't about someone in this settlement, is dropped.
 */
function cleanPaynow(paynow, session) {
  const out = {};
  if (!paynow || typeof paynow !== 'object') return out;
  for (const participant of session.participants) {
    const value = paynow[participant.id];
    if (typeof value === 'string' && /^\+?[\d ]{4,20}$/.test(value.trim())) out[participant.id] = value.trim();
  }
  return out;
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

  /**
   * Prepares a formatted message for the person using the Mini App, to send to a chat
   * of their choice. They must prove who they are with Telegram's signed initData.
   * Body: { initData, kind: 'group' | 'person', participantId?, paynow?: { [participantId]: number } }
   */
  app.post('/sessions/:sessionId/telegram-share', async (req, res, next) => {
    try {
      const { initData, kind, participantId, paynow } = req.body ?? {};
      const auth = validateInitData(initData, token);
      if (!auth) {
        return res.status(401).json({ error: 'Telegram could not confirm who you are. Open the app from Telegram and try again.' });
      }
      if (kind !== 'group' && kind !== 'person') {
        return res.status(400).json({ error: "kind must be 'group' or 'person'" });
      }

      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const settlement = computeSessionSettlement(session);
      if (!settlement.ok) {
        return res.status(409).json({ error: 'Finish assigning every item before sharing.', reason: settlement.reason });
      }

      const numbers = cleanPaynow(paynow, session);
      let html;
      let title;
      if (kind === 'group') {
        html = groupMessageHtml(session, settlement, { paynow: numbers });
        title = 'Settlement summary';
      } else {
        const person = session.participants.find((p) => p.id === participantId);
        if (!person) return res.status(400).json({ error: 'Unknown participant' });
        html = personalMessageHtml(session, settlement, person.id, { paynow: numbers });
        if (!html) return res.status(409).json({ error: `${person.name} has nothing to pay.` });
        title = `Message for ${person.name}`;
      }

      let prepared;
      try {
        prepared = await telegram.savePreparedInlineMessage({
          userId: auth.user.id,
          result: { type: 'article', id: 'share', title, input_message_content: { message_text: html, parse_mode: 'HTML' } },
        });
      } catch (err) {
        console.error(`Preparing a Telegram message failed: ${err.message}`);
        return res.status(502).json({ error: 'Telegram could not prepare the message. You can still copy it instead.' });
      }
      res.json({ preparedMessageId: prepared.id });
    } catch (err) {
      next(err);
    }
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
