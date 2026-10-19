// A thin Telegram Bot API client. No framework: just the handful of calls the
// bot needs, with fetch injectable so it can be tested without the network.
//
// Error messages never include the bot token (it is part of every URL).

export function createTelegram({ token, fetchImpl = fetch }) {
  if (!token) throw new Error('A Telegram bot token is required');
  const apiBase = `https://api.telegram.org/bot${token}`;

  async function call(method, params = {}) {
    const res = await fetchImpl(`${apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const err = new Error(`Telegram ${method} failed: ${data?.description ?? res.status}`);
      err.status = res.status;
      throw err;
    }
    return data.result;
  }

  return {
    call,

    sendMessage(chatId, text, extra = {}) {
      return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
    },

    editMessageText(chatId, messageId, text, extra = {}) {
      return call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
    },

    removeButtons(chatId, messageId) {
      return call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    },

    answerCallbackQuery(callbackQueryId) {
      return call('answerCallbackQuery', { callback_query_id: callbackQueryId });
    },

    /**
     * Saves a message the Mini App's user can then send to a chat of their choice
     * (Mini App -> shareMessage). Returns { id, expiration_date }.
     */
    savePreparedInlineMessage({ userId, result }) {
      return call('savePreparedInlineMessage', {
        user_id: userId,
        result,
        allow_user_chats: true,
        allow_group_chats: true,
        allow_bot_chats: false,
        allow_channel_chats: false,
      });
    },

    setWebhook({ url, secret }) {
      return call('setWebhook', {
        url,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
      });
    },

    /** Downloads a file Telegram is holding (a photo the user sent). */
    async downloadFile(fileId) {
      const file = await call('getFile', { file_id: fileId });
      const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), filePath: file.file_path };
    },
  };
}
