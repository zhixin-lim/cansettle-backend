import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegram } from './telegram.mjs';

test('calls the Bot API with JSON and returns the result', async () => {
  const seen = [];
  const tg = createTelegram({
    token: '123:SECRET',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });
  const sent = await tg.sendMessage(42, 'hi', { reply_markup: { x: 1 } });
  assert.deepEqual(sent, { message_id: 7 });
  assert.equal(seen[0].url, 'https://api.telegram.org/bot123:SECRET/sendMessage');
  assert.deepEqual(JSON.parse(seen[0].init.body), { chat_id: 42, text: 'hi', parse_mode: 'HTML', reply_markup: { x: 1 } });
});

test('errors never contain the bot token', async () => {
  const tg = createTelegram({
    token: '123:SECRET',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) }),
  });
  await assert.rejects(tg.sendMessage(1, 'x'), (err) => err.message.includes('chat not found') && !err.message.includes('SECRET'));
});

test('downloadFile fetches the file path Telegram returns', async () => {
  const urls = [];
  const tg = createTelegram({
    token: 't',
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/getFile')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg' } }) };
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    },
  });
  const { bytes, filePath } = await tg.downloadFile('FILEID');
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(filePath, 'photos/file_1.jpg');
  assert.equal(urls[1], 'https://api.telegram.org/file/bott/photos/file_1.jpg');
});
