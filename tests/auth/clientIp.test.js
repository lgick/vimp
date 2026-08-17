import { describe, it, expect } from 'vitest';
import { clientIp } from '../../packages/auth/src/lib/clientIp.js';

// Ключ лимитов auth-сервиса (перебор ников, старт OAuth). Копия хелпера
// движка — auth не тянет на него рантайм-зависимость, поэтому контракт
// проверяется здесь отдельно (как и у rateLimiter.js).

const makeReq = (headers = {}, remoteAddress = '5.5.5.5') => ({
  headers,
  socket: { remoteAddress },
});

describe('clientIp (auth)', () => {
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

  it('разорванный сокет даёт пустую строку, а не бросок', () => {
    expect(clientIp({ headers: {}, socket: {} })).toBe('');
  });
});
