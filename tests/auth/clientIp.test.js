import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clientIp } from '../../packages/auth/src/lib/clientIp.js';

// Ключ лимитов auth-сервиса (перебор ников, старт OAuth). Копия хелпера
// движка — auth не тянет на него рантайм-зависимость, поэтому контракт
// проверяется здесь отдельно (как и у rateLimiter.js), теми же кейсами, что
// в tests/lib/clientIp.test.js: разъедутся копии — разъедутся и наборы.

const makeReq = (headers = {}, remoteAddress = '5.5.5.5') => ({
  headers,
  socket: { remoteAddress },
});

// часть кейсов ходит по ветке «за прокси, а заголовка нет» — она предупреждает
// (review-4.md, R4-4), и в протоколе прогона это был бы шум
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clientIp (auth)', () => {
  it('без прокси берёт адрес сокета', () => {
    expect(clientIp(makeReq())).toBe('5.5.5.5');
  });

  it('X-Forwarded-For не является ключом ни в одном режиме', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 5.5.5.5' });

    expect(clientIp(req)).toBe('5.5.5.5');
    expect(clientIp(req, { trustProxy: true })).toBe('5.5.5.5');
  });

  it('X-Real-IP берётся только за прокси', () => {
    const req = makeReq({ 'x-real-ip': '1.2.3.4' });

    expect(clientIp(req)).toBe('5.5.5.5');
    expect(clientIp(req, { trustProxy: true })).toBe('1.2.3.4');
  });

  it('пустой X-Real-IP за прокси не отменяет адрес сокета', () => {
    const req = makeReq({ 'x-real-ip': '' });

    expect(clientIp(req, { trustProxy: true })).toBe('5.5.5.5');
  });

  it('разорванный сокет даёт пустую строку, а не бросок', () => {
    expect(clientIp({ headers: {}, socket: {} })).toBe('');
    expect(clientIp({ headers: {} })).toBe('');
  });
});

// review-4.md (R4-4): прокси без `proxy_set_header X-Real-IP $remote_addr`
// схлопывает лимиты перебора ников и старта OAuth в один общий бакет
describe('clientIp (auth): прокси без X-Real-IP', () => {
  // флаг «уже предупредили» живёт в модуле, поэтому модуль берётся свежим
  const freshClientIp = async () => {
    vi.resetModules();

    return (await import('../../packages/auth/src/lib/clientIp.js')).clientIp;
  };

  it('предупреждает один раз на процесс, а не на каждый запрос', async () => {
    const fresh = await freshClientIp();
    const req = makeReq();

    expect(fresh(req, { trustProxy: true })).toBe('5.5.5.5');
    expect(fresh(req, { trustProxy: true })).toBe('5.5.5.5');

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.mock.calls[0][0]).toMatch(/X-Real-IP/);
  });

  it('не предупреждает, когда заголовок на месте или прокси нет', async () => {
    const fresh = await freshClientIp();

    fresh(makeReq({ 'x-real-ip': '1.2.3.4' }), { trustProxy: true });
    fresh(makeReq());

    expect(console.warn).not.toHaveBeenCalled();
  });
});
