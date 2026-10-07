import { describe, it, expect } from 'vitest';
import chatMessages from '../../packages/engine/src/config/chatMessages.js';
import {
  ENGINE_MESSAGE_CODES,
  registerCodes,
} from '../../packages/engine/src/host/meta/modules/chat/systemMessages.js';
import { RESERVED } from '../../packages/engine/src/devtools/contract/rules/b8-system-messages.js';

const parse = code => {
  const [group, index] = code.split(':');

  return { group, index: Number(index) };
};

describe('chatMessages: английские тексты движковых кодов', () => {
  it('у каждого движкового кода есть непустой текст', () => {
    for (const [key, code] of Object.entries(ENGINE_MESSAGE_CODES)) {
      const { group, index } = parse(code);
      const text = chatMessages[group]?.[index];

      expect(typeof text === 'string' && text !== '', `${key} (${code})`).toBe(
        true,
      );
    }
  });

  it('каждый индекс таблицы имеет код (взаимно-однозначно)', () => {
    const codes = new Set(Object.values(ENGINE_MESSAGE_CODES));

    for (const [group, texts] of Object.entries(chatMessages)) {
      texts.forEach((_, index) => {
        expect(codes.has(`${group}:${index}`), `${group}:${index}`).toBe(true);
      });
    }
  });

  it('RESERVED совпадает с длинами групп таблицы', () => {
    for (const group of Object.keys(RESERVED)) {
      expect(RESERVED[group]).toBe(chatMessages[group].length - 1);
    }
  });

  it('в таблице только группы s, v, m, c, n', () => {
    expect(Object.keys(chatMessages).sort()).toEqual(['c', 'm', 'n', 's', 'v']);
    expect(Object.keys(RESERVED).sort()).toEqual(['c', 'm', 'n', 's', 'v']);
  });

  it('registerCodes не меняет ENGINE_MESSAGE_CODES', () => {
    const before = { ...ENGINE_MESSAGE_CODES };

    registerCodes({ GAME_X: 'g:0' });

    expect(ENGINE_MESSAGE_CODES).toEqual(before);
    expect(Object.isFrozen(ENGINE_MESSAGE_CODES)).toBe(true);
  });
});
