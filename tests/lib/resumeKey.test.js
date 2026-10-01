import { describe, it, expect } from 'vitest';
import {
  createResumeKey,
  resumeKeysEqual,
} from '../../packages/engine/src/lib/resumeKey.js';

describe('resumeKey', () => {
  it('ключ — 128 бит в hex', () => {
    expect(createResumeKey()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ключи не повторяются', () => {
    expect(createResumeKey()).not.toBe(createResumeKey());
  });

  it('сравнение: равные строки', () => {
    const key = createResumeKey();

    expect(resumeKeysEqual(key, `${key}`)).toBe(true);
  });

  it('сравнение: другая строка, другая длина, не строка', () => {
    expect(resumeKeysEqual('abcd', 'abce')).toBe(false);
    expect(resumeKeysEqual('abcd', 'abc')).toBe(false);
    expect(resumeKeysEqual(undefined, 'abc')).toBe(false);
    expect(resumeKeysEqual(null, null)).toBe(false);
  });
});
