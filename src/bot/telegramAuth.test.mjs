import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData } from './telegramAuth.mjs';

const TOKEN = '123456:TEST-TOKEN';
const AUTH_DATE = 1700000000;
const justAfter = () => (AUTH_DATE + 60) * 1000;

// Signed with an independent implementation (Python's hmac), so this checks the
// algorithm against the standard rather than against this file's own code.
const KNOWN_GOOD = 'auth_date=1700000000&query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Zhi+Xin%22%2C%22username%22%3A%22zx%22%7D&hash=0d77b71ed8f72c7c776f8703da63885875cac75a96ec01d732f8e1370a0db041';

test('accepts initData signed the way Telegram signs it', () => {
  const result = validateInitData(KNOWN_GOOD, TOKEN, { now: justAfter });
  assert.equal(result.user.id, 42);
  assert.equal(result.user.first_name, 'Zhi Xin');
  assert.equal(result.authDate, AUTH_DATE);
});

test('rejects data signed with a different bot token', () => {
  assert.equal(validateInitData(KNOWN_GOOD, '999:OTHER', { now: justAfter }), null);
});

test('rejects tampered data (someone swapping in another user id)', () => {
  const tampered = KNOWN_GOOD.replace('%22id%22%3A42', '%22id%22%3A43');
  assert.notEqual(tampered, KNOWN_GOOD);
  assert.equal(validateInitData(tampered, TOKEN, { now: justAfter }), null);
});

test('rejects missing, empty and malformed input', () => {
  for (const bad of [undefined, null, '', 'garbage', 'auth_date=1&user=%7B%7D', KNOWN_GOOD.replace(/hash=[0-9a-f]+/, 'hash=abc')]) {
    assert.equal(validateInitData(bad, TOKEN, { now: justAfter }), null);
  }
  assert.equal(validateInitData(KNOWN_GOOD, '', { now: justAfter }), null);
});

test('rejects data older than a day', () => {
  assert.equal(validateInitData(KNOWN_GOOD, TOKEN, { now: () => (AUTH_DATE + 2 * 24 * 3600) * 1000 }), null);
  assert.ok(validateInitData(KNOWN_GOOD, TOKEN, { now: () => (AUTH_DATE + 23 * 3600) * 1000 }));
});

test('a validly signed payload without a user is refused', () => {
  const fields = { auth_date: String(AUTH_DATE), query_id: 'x' };
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  const initData = new URLSearchParams({ ...fields, hash }).toString();
  assert.equal(validateInitData(initData, TOKEN, { now: justAfter }), null);
});
