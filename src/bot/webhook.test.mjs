import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { webhookSecret } from './index.mjs';

const TOKEN = '123456:TEST-TOKEN';

function start(bot) {
  const app = createApp({ bot });
  const server = app.listen(0);
  return { app, server, url: `http://localhost:${server.address().port}` };
}
const post = (url, body, headers = {}) =>
  fetch(`${url}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the webhook only accepts calls carrying Telegram\'s secret header', async () => {
  const handled = [];
  const { server, url } = start({ env: { TELEGRAM_BOT_TOKEN: TOKEN }, tg: {}, handler: { handleUpdate: (u) => handled.push(u) } });
  try {
    assert.equal((await post(url, { update_id: 1 })).status, 401);
    assert.equal((await post(url, { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 401);
    assert.equal((await post(url, { update_id: 1 }, { 'x-telegram-bot-api-secret-token': webhookSecret('999:OTHER') })).status, 401);
    assert.equal(handled.length, 0);

    const good = await post(url, { update_id: 2, message: {} }, { 'x-telegram-bot-api-secret-token': webhookSecret(TOKEN) });
    assert.equal(good.status, 200);
    assert.deepEqual(handled, [{ update_id: 2, message: {} }]);
  } finally {
    server.close();
  }
});

test('Telegram gets its 200 straight away, even if handling is slow or fails', async () => {
  const { server, url } = start({
    env: { TELEGRAM_BOT_TOKEN: TOKEN },
    tg: {},
    handler: { handleUpdate: () => new Promise(() => {}) }, // never finishes
  });
  try {
    const res = await post(url, { update_id: 3 }, { 'x-telegram-bot-api-secret-token': webhookSecret(TOKEN) });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('without a bot token there is no webhook and the API is unchanged', async () => {
  const { app, server, url } = start({ env: {} });
  try {
    assert.equal(app.locals.bot.enabled, false);
    assert.equal((await post(url, { update_id: 1 })).status, 404);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    server.close();
  }
});

test('the webhook is registered with Telegram using the public URL and the secret', async () => {
  const calls = [];
  const tg = { setWebhook: async (args) => calls.push(args) };
  const mk = (env) => createApp({ bot: { env: { TELEGRAM_BOT_TOKEN: TOKEN, ...env }, tg, handler: {} } }).locals.bot;

  assert.equal(await mk({ PUBLIC_URL: 'https://api.example.app/' }).registerWebhook(), true);
  assert.deepEqual(calls[0], { url: 'https://api.example.app/telegram/webhook', secret: webhookSecret(TOKEN) });

  await mk({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).registerWebhook();
  assert.equal(calls[1].url, 'https://x.up.railway.app/telegram/webhook');

  assert.equal(await mk({}).registerWebhook(), false);
  assert.equal(calls.length, 2);
});
