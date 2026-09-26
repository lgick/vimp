import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rateLimitKey } from '../../packages/engine/src/lib/clientIp.js';

const MODULE = '../../packages/engine/src/lib/clientIp.js';

// Ключ rate-limit'ов серверных контуров (review-3.md, R3-1). Главное здесь —
// что X-Forwarded-For не используется НИКОГДА: Nginx деплоя дописывает
// реальный адрес к присланному клиентом, поэтому первый адрес списка
// подделывается тривиально (обход лимита и захват чужого бакета).

const makeReq = (headers = {}, remoteAddress = '5.5.5.5') => ({
  headers,
  socket: { remoteAddress },
});

// Флаг «уже предупредили» живёт в модуле, поэтому модуль берётся свежим на
// КАЖДЫЙ кейс: со статическим импортом кейс, ходящий по ветке предупреждения,
// сжигал бы флаг для всех следующих, и результат зависел бы от порядка кейсов
// в файле (review-5.md, R5-5). Эта же ветка пишет в console.warn — в протоколе
// прогона это был бы шум (review-4.md, R4-4)
let clientIp;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ({ clientIp } = await import(MODULE));
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
  it('предупреждает один раз на процесс, а не на каждое соединение', () => {
    const req = makeReq();

    expect(clientIp(req, { trustProxy: true })).toBe('5.5.5.5');
    expect(clientIp(req, { trustProxy: true })).toBe('5.5.5.5');
    expect(clientIp(req, { trustProxy: true })).toBe('5.5.5.5');

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.mock.calls[0][0]).toMatch(/X-Real-IP/);
  });

  it('не предупреждает, когда заголовок на месте или прокси нет', () => {
    clientIp(makeReq({ 'x-real-ip': '1.2.3.4' }), { trustProxy: true });
    clientIp(makeReq());

    expect(console.warn).not.toHaveBeenCalled();
  });
});

// Ключ лимита по адресу (plan/client-reports, этап 2): у абонента IPv6 целая
// /64, поэтому лимит «на адрес» для IPv6 обходится сменой адреса
describe('rateLimitKey', () => {
  it('IPv4 — адрес как есть, IPv4-mapped — его IPv4', () => {
    expect(rateLimitKey('1.2.3.4')).toBe('1.2.3.4');
    expect(rateLimitKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('адреса одной /64 делят ключ, соседняя /64 — другой', () => {
    const a = rateLimitKey('2001:db8:0:1::a');
    const b = rateLimitKey('2001:db8:0:1:ffff::1');

    expect(a).toBe('v6:2001:db8:0:1::/64');
    expect(b).toBe(a);
    expect(rateLimitKey('2001:db8:0:2::a')).not.toBe(a);
  });

  it('полная запись, ведущие нули и регистр сводятся к одному ключу', () => {
    expect(rateLimitKey('2001:0DB8:0000:0001:0000:0000:0000:000a')).toBe(
      'v6:2001:db8:0:1::/64',
    );
  });

  it('сокращённая запись и зона', () => {
    expect(rateLimitKey('::1')).toBe('v6:0:0:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('v6:fe80:0:0:0::/64');
  });

  it("мусор — строка как есть, '' — ''", () => {
    expect(rateLimitKey('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(rateLimitKey('zz:yy')).toBe('zz:yy');
    expect(rateLimitKey('')).toBe('');
  });
});
