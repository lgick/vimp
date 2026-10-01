import crypto from 'crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveRoomSecret,
  verifyRoomSecret,
} from '../../packages/engine/src/master/roomSecret.js';

const KEY = 'k'.repeat(32);
const FIELDS = { roomId: 'abcd1234', epoch: 1, userId: 7 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveRoomSecret', () => {
  it('детерминирован и в base64url', () => {
    const secret = deriveRoomSecret(KEY, FIELDS);

    expect(deriveRoomSecret(KEY, FIELDS)).toBe(secret);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('зависит от каждого поля и от ключа', () => {
    const base = deriveRoomSecret(KEY, FIELDS);

    for (const changed of [
      { ...FIELDS, roomId: 'abcd1235' },
      { ...FIELDS, epoch: 2 },
      { ...FIELDS, userId: 8 },
    ]) {
      expect(deriveRoomSecret(KEY, changed)).not.toBe(base);
    }

    expect(deriveRoomSecret('x'.repeat(32), FIELDS)).not.toBe(base);
  });
});

describe('verifyRoomSecret', () => {
  it('верный секрет принимается, чужой — нет', () => {
    const secret = deriveRoomSecret(KEY, FIELDS);

    expect(verifyRoomSecret(KEY, secret, FIELDS)).toBe(true);
    expect(verifyRoomSecret(KEY, secret, { ...FIELDS, userId: 8 })).toBe(false);
    expect(verifyRoomSecret('x'.repeat(32), secret, FIELDS)).toBe(false);
  });

  it('сравнение — timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');

    verifyRoomSecret(KEY, deriveRoomSecret(KEY, FIELDS), FIELDS);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '', 42, {}, 'short', 'é'.repeat(43)])(
    'мусор %s — false без исключения',
    secret => {
      expect(verifyRoomSecret(KEY, secret, FIELDS)).toBe(false);
    },
  );
});
