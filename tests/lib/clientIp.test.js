import { describe, it, expect } from 'vitest';
import { clientIp } from '../../packages/engine/src/lib/clientIp.js';

// Ключ rate-limit'ов серверных контуров (review-3.md, R3-1). Главное здесь —
// что X-Forwarded-For не используется НИКОГДА: Nginx деплоя дописывает
// реальный адрес к присланному клиентом, поэтому первый адрес списка
// подделывается тривиально (обход лимита и захват чужого бакета).

const makeReq = (headers = {}, remoteAddress = '5.5.5.5') => ({
  headers,
  socket: { remoteAddress },
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
