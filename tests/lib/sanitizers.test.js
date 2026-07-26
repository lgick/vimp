import { describe, it, expect } from 'vitest';
import { sanitizeMessage } from '../../packages/engine/src/lib/sanitizers.js';

describe('sanitizeMessage', () => {
  it('удаляет управляющие символы (ломают однострочный чат)', () => {
    expect(sanitizeMessage('a\nb\tc')).toBe('abc');
    expect(sanitizeMessage('text\x00\x07end')).toBe('textend');
    expect(sanitizeMessage('line\r\nbreak')).toBe('linebreak');
  });

  it('оставляет обычный текст без изменений', () => {
    expect(sanitizeMessage('normal text 123')).toBe('normal text 123');
  });

  it('пропускает пунктуацию и угловые скобки (XSS закрыт на выводе)', () => {
    expect(sanitizeMessage('кто-то')).toBe('кто-то');
    expect(sanitizeMessage('2 < 5 > 1')).toBe('2 < 5 > 1');
    expect(sanitizeMessage(`hello & "world" (test); C++ 50%`)).toBe(
      `hello & "world" (test); C++ 50%`,
    );
  });

  it('возвращает пустую строку для не-строки', () => {
    expect(sanitizeMessage(123)).toBe('');
    expect(sanitizeMessage(null)).toBe('');
    expect(sanitizeMessage(undefined)).toBe('');
    expect(sanitizeMessage({})).toBe('');
  });
});
