import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import config from '../../packages/engine/src/lib/config.js';

describe('config', () => {
  beforeEach(() => {
    // глушим ожидаемые console.error в негативных кейсах
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('set/get простого ключа', () => {
    config.set('alpha', 1);
    expect(config.get('alpha')).toBe(1);
  });

  it('set/get вложенного пути', () => {
    config.set('a:b:c', 'deep');
    expect(config.get('a:b:c')).toBe('deep');
    expect(config.get('a:b')).toEqual({ c: 'deep' });
  });

  it('перезапись пути затирает старую вложенность', () => {
    config.set('x:y:z', 1);
    config.set('x:y', 2);
    expect(config.get('x:y')).toBe(2);
  });

  it('get без аргументов возвращает весь конфиг', () => {
    config.set('root', 'val');
    const all = config.get();
    expect(all).toHaveProperty('root', 'val');
  });

  it('set с пустым ключом не пишет и логирует ошибку', () => {
    config.set('', 'nope');
    expect(console.error).toHaveBeenCalled();
  });

  it('set с пустыми сегментами отклоняется', () => {
    config.set('a::b', 'nope');
    expect(console.error).toHaveBeenCalled();
  });

  it('get несуществующего ключа возвращает undefined', () => {
    expect(config.get('does:not:exist')).toBeUndefined();
  });

  it('get при обращении через примитив возвращает undefined', () => {
    config.set('prim', 5);
    expect(config.get('prim:sub')).toBeUndefined();
  });
});
