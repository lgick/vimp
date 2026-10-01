import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import {
  ROOM_ID_LENGTH,
  generateRoomId,
  isValidRoomId,
} from '../../packages/engine/src/lib/roomId.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

describe('generateRoomId', () => {
  it('8 символов crockford-base32 в нижнем регистре', () => {
    const id = generateRoomId(crypto.randomBytes);

    expect(ROOM_ID_LENGTH).toBe(8);
    expect(id).toHaveLength(8);
    expect([...id].every(ch => ALPHABET.includes(ch))).toBe(true);
    expect(isValidRoomId(id)).toBe(true);
  });

  it('байт отображается на символ по модулю 32', () => {
    const bytes = [0, 31, 32, 255, 10, 17, 18, 27];

    expect(generateRoomId(() => Uint8Array.from(bytes))).toBe('0z0zahjv');
  });

  it('уникальны на выборке', () => {
    const ids = new Set();

    for (let i = 0; i < 2000; i += 1) {
      ids.add(generateRoomId(crypto.randomBytes));
    }

    expect(ids.size).toBe(2000);
  });
});

describe('isValidRoomId', () => {
  it.each(['abcd1234', '00000000', 'zzzzzzzz'])('принимает %s', id => {
    expect(isValidRoomId(id)).toBe(true);
  });

  it.each([
    'abcd123', // короче
    'abcd12345', // длиннее
    'ABCD1234', // верхний регистр
    'abcd123i', // i, l, o, u вне алфавита
    'abcd123l',
    'abcd123o',
    'abcd123u',
    'abcd-123',
    '',
    null,
    12345678,
  ])('отклоняет %s', id => {
    expect(isValidRoomId(id)).toBe(false);
  });
});
