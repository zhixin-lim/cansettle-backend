// The bot's conversation: turns Telegram updates into actions.
//
//   /start -> send a receipt photo -> bot reads it -> user checks it
//   -> "Looks right" saves it as a bill -> "another receipt?" -> ... -> "That's all"
//   -> button that opens the mini app on that settlement
//
// Everything outside (Telegram, Gemini, the database) is passed in, so the
// whole flow can be tested with fakes.

import { randomBytes } from 'node:crypto';
import * as msg from './messages.mjs';

const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Sequential steps for one chat can't overlap, but different chats run in parallel. */
export function createLimiter({ max = 8, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}

/**
 * The frontend works out each line as quantity x unit price, so a line is only
 * saved with a quantity when the total divides evenly. Otherwise it becomes a
 * single line with the quantity in its name, so no cent is ever lost.
 */
export function toBillItems(items) {
  return items.map((item) => {
    if (item.qty > 1 && item.totalCents % item.qty === 0) {
      return { name: item.name, quantity: item.qty, unitPriceCents: item.totalCents / item.qty, totalCents: item.totalCents };
    }
    return {
      name: item.qty > 1 ? `${item.name} (x${item.qty})` : item.name,
      quantity: 1,
      unitPriceCents: item.totalCents,
      totalCents: item.totalCents,
    };
  });
}

function mimeFor(filePath, declared) {
  if (declared?.startsWith('image/')) return declared;
  const ext = filePath?.split('.').pop()?.toLowerCase();
  return { png: 'image/png', webp: 'image/webp', heic: 'image/heic' }[ext] ?? 'image/jpeg';
}

function commandOf(text) {
  const match = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(text ?? '');
  return match ? match[1].toLowerCase() : null;
}

export function createBotHandler({
  tg,
  readReceipt,
  store,
  miniAppUrl = 'https://cansettle.lovable.app',
  limiter = createLimiter(),
  log = console,
}) {
  const appUrl = miniAppUrl.replace(/\/+$/, '');
  const queues = new Map(); // chatId -> promise: one chat's updates run in order
  const seen = new Set(); // recent update ids, so a Telegram retry isn't handled twice

  const say = (chatId, text, extra) => tg.sendMessage(chatId, text, extra);

  async function startFresh(chatId) {
    await store.clearChatState(chatId);
  }

  /* -------------------------------------------------------------- manual */

  /**
   * Starts a settlement with no photo: creates it with the sender as the first
   * person, and opens the app on it. Nothing more for the bot to do afterwards.
   */
  async function startManual(chatId, from) {
    await store.clearChatState(chatId);
    const session = await store.createSession({});
    const name = (from?.first_name ?? 'Me').toString().trim().slice(0, 40) || 'Me';
    await store.addParticipant(session.id, { name });
    return say(chatId, msg.manualReady(), {
      reply_markup: {
        inline_keyboard: [[{ text: msg.buttons.openApp, web_app: { url: `${appUrl}/?session=${session.id}` } }]],
      },
    });
  }

  /* -------------------------------------------------------------- photos */

  async function handlePhoto(chatId, message) {
    const from = message.from;
    const photo = message.photo?.[message.photo.length - 1] ?? message.document;
    if (photo.file_size && photo.file_size > MAX_FILE_BYTES) return say(chatId, msg.cantRead());

    if (!limiter.allow(chatId)) return say(chatId, msg.tooMany());

    const working = await say(chatId, msg.reading());
    const showError = (text) => tg.editMessageText(chatId, working.message_id, text).catch(() => say(chatId, text));

    let receipt;
    try {
      const { bytes, filePath } = await tg.downloadFile(photo.file_id);
      receipt = await readReceipt({ bytes, mimeType: mimeFor(filePath, message.document?.mime_type) });
    } catch (err) {
      if (err.code === 'NOT_A_RECEIPT') return showError(msg.notAReceipt());
      if (err.code === 'UNREADABLE') return showError(msg.cantRead());
      // BUSY, CONFIG or anything unexpected: tell the user it's us, and log why.
      log.error(`Receipt reading failed (${err.code ?? 'unexpected'}): ${err.message}`);
      return showError(msg.busy());
    }

    const state = (await store.getChatState(chatId)) ?? {};
    state.pending = { id: randomBytes(4).toString('hex'), receipt };
    state.hostName = state.hostName ?? from?.first_name ?? null;
    await store.setChatState(chatId, state);

    const keyboard = {
      inline_keyboard: [
        [
          { text: msg.buttons.looksRight, callback_data: `ok:${state.pending.id}` },
          { text: msg.buttons.retake, callback_data: `retake:${state.pending.id}` },
        ],
      ],
    };
    const text = msg.receiptReview(receipt, { number: (state.receiptCount ?? 0) + 1 });
    await tg
      .editMessageText(chatId, working.message_id, text, { reply_markup: keyboard })
      .catch(() => say(chatId, text, { reply_markup: keyboard }));
  }

  /* ------------------------------------------------------------- buttons */

  async function ensureSession(chatId, state, fallbackName) {
    if (state.sessionId) {
      const meta = await store.getSessionMeta(state.sessionId);
      if (!meta || new Date(meta.expiresAt).getTime() <= Date.now()) return null;
      return state;
    }
    const session = await store.createSession({});
    // The person sending the receipt is taken to be the one who paid; they can change that in the app.
    const name = (state.hostName ?? fallbackName ?? 'Me').toString().trim().slice(0, 40) || 'Me';
    const host = await store.addParticipant(session.id, { name });
    state.sessionId = session.id;
    state.hostId = host.id;
    return state;
  }

  async function handleButton(chatId, callback) {
    const messageId = callback.message?.message_id;
    await tg.answerCallbackQuery(callback.id).catch(() => {});
    const [action, token] = String(callback.data ?? '').split(':');
    if (action === 'manual') return startManual(chatId, callback.from);
    const state = await store.getChatState(chatId);

    const stale = async () => {
      if (messageId) await tg.removeButtons(chatId, messageId).catch(() => {});
      return say(chatId, msg.staleButton());
    };
    if (!state) return stale();

    if (action === 'ok' || action === 'retake') {
      // The button must belong to the receipt currently waiting for an answer.
      if (!state.pending || state.pending.id !== token) return stale();
      if (messageId) await tg.removeButtons(chatId, messageId).catch(() => {});

      if (action === 'retake') {
        delete state.pending;
        await store.setChatState(chatId, state);
        return say(chatId, msg.askForPhoto());
      }

      const ready = await ensureSession(chatId, state, callback.from?.first_name);
      if (!ready) {
        await startFresh(chatId);
        return say(chatId, msg.sessionGone());
      }
      const { receipt } = state.pending;
      await store.addBill(state.sessionId, {
        name: receipt.merchant,
        source: 'receipt',
        payerId: state.hostId,
        discountCents: receipt.discountCents ?? 0,
        serviceChargeCents: receipt.serviceChargeCents,
        gstCents: receipt.gstCents,
        totalCents: receipt.totalCents,
        items: toBillItems(receipt.items),
      });
      state.receiptCount = (state.receiptCount ?? 0) + 1;
      state.totalCents = (state.totalCents ?? 0) + receipt.totalCents;
      delete state.pending;
      await store.setChatState(chatId, state);

      return say(chatId, `${msg.receiptAdded(receipt)}\n\n${msg.anotherReceipt(state.receiptCount)}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: msg.buttons.anotherYes, callback_data: 'more' },
              { text: msg.buttons.anotherNo, callback_data: 'done' },
            ],
          ],
        },
      });
    }

    if (action === 'more') {
      if (messageId) await tg.removeButtons(chatId, messageId).catch(() => {});
      return say(chatId, msg.nextReceipt());
    }

    if (action === 'done') {
      if (messageId) await tg.removeButtons(chatId, messageId).catch(() => {});
      if (!state.sessionId || !state.receiptCount) return stale();
      const url = `${appUrl}/?session=${state.sessionId}`;
      await say(chatId, msg.readyToOpen({ receiptCount: state.receiptCount, totalCents: state.totalCents ?? 0 }), {
        reply_markup: { inline_keyboard: [[{ text: msg.buttons.openApp, web_app: { url } }]] },
      });
      // The settlement lives on in the app; the next photo starts a fresh one.
      return store.clearChatState(chatId);
    }

    return stale();
  }

  /* ------------------------------------------------------------ messages */

  async function handleMessage(chatId, message) {
    if (message.chat?.type !== 'private') {
      if (commandOf(message.text)) await say(chatId, msg.privateOnly());
      return;
    }

    const command = commandOf(message.text);
    if (command === 'start') {
      await startFresh(chatId);
      return say(chatId, msg.welcome(), {
        reply_markup: { inline_keyboard: [[{ text: msg.buttons.manual, callback_data: 'manual' }]] },
      });
    }
    if (command === 'manual') return startManual(chatId, message.from);
    if (command === 'help') return say(chatId, msg.help());
    if (command === 'cancel') {
      const had = await store.getChatState(chatId);
      await store.clearChatState(chatId);
      return say(chatId, had ? msg.cancelled() : msg.nothingToCancel());
    }

    const isImageFile = message.document?.mime_type?.startsWith('image/');
    if (message.photo?.length || isImageFile) return handlePhoto(chatId, message);
    return say(chatId, msg.sendAPhoto());
  }

  /* --------------------------------------------------------------- entry */

  async function process(update) {
    if (update.callback_query) {
      const chatId = update.callback_query.message?.chat?.id;
      if (chatId == null) return;
      return handleButton(chatId, update.callback_query);
    }
    if (update.message?.chat?.id != null) return handleMessage(update.message.chat.id, update.message);
  }

  function handleUpdate(update) {
    if (update?.update_id != null) {
      if (seen.has(update.update_id)) return Promise.resolve();
      seen.add(update.update_id);
      if (seen.size > 500) seen.delete(seen.values().next().value);
    }
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    if (chatId == null) return Promise.resolve();

    const previous = queues.get(chatId) ?? Promise.resolve();
    const run = previous
      .then(() => process(update))
      .catch((err) => log.error(`Bot update failed: ${err.message}`))
      .finally(() => {
        if (queues.get(chatId) === run) queues.delete(chatId);
      });
    queues.set(chatId, run);
    return run;
  }

  return { handleUpdate };
}
