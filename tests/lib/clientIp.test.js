import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clientIp } from '../../packages/engine/src/lib/clientIp.js';

// Ключ rate-limit'ов серверных контуров (review-3.md, R3-1). Главное здесь —
// что X-Forwarded-For не используется НИКОГДА: Nginx деплоя дописывает
// реальный адрес к присланному клиентом, поэтому первый адрес списка
// подделывается тривиально (обход лимита и захват чужого бакета).

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

describe('clientIp', () => {
  it('без прокси берёт адрес сокета', () => {
    expect(clientIp(makeReq())).toBe('5.5.5.5');
  });

  it('X-Forwarded-For игнорируется в обоих режимах', () => {
    const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 5.5.5.5' });

    expect(clientIp(req)).toBe('5.5.5.5');
    expect(clientIp(req, { trustProxy: true })).toBe('5.5.5.5');
  });

  it('X-Real-IP берётся только при trustProxy', () => {
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
// схлопывает ключ в адрес самого прокси — один общий бакет на всех клиентов,
// то есть одна комната на весь мастер. Молча деградировать в такое нельзя
describe('clientIp: прокси без X-Real-IP', () => {
  // флаг «уже предупредили» живёт в модуле, поэтому модуль берётся свежим
  const freshClientIp = async () => {
    vi.resetModules();

    return (await import('../../packages/engine/src/lib/clientIp.js')).clientIp;
  };

  it('предупреждает один раз на процесс, а не на каждое соединение', async () => {
    const fresh = await freshClientIp();
    const req = makeReq();

    expect(fresh(req, { trustProxy: true })).toBe('5.5.5.5');
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
