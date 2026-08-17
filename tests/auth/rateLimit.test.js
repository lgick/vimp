import { describe, it, expect, vi } from 'vitest';
import rateLimit from '../../packages/auth/src/lib/rateLimit.js';
import RateLimiter from '../../packages/auth/src/lib/rateLimiter.js';

// Middleware лимитов auth-сервиса (перебор ников, старт OAuth). Вынесен из
// main.js ровно ради этого файла: main.js при импорте поднимает сервер и
// тянет пул БД, то есть контракт лимита в нём не проверить.

const makeReq = (headers = {}, remoteAddress = '5.5.5.5') => ({
  headers,
  socket: { remoteAddress },
});

// минимальный двойник express-ответа: важны только статус и тело
const makeRes = () => {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;

      return res;
    },
    json(payload) {
      res.body = payload;

      return res;
    },
  };

  return res;
};

describe('rateLimit', () => {
  it('пропускает, пока окно не выбрано, и отбивает 429 дальше', () => {
    const middleware = rateLimit(new RateLimiter({ limit: 2, windowMs: 60000 }));
    const next = vi.fn();
    const run = () => {
      const res = makeRes();

      middleware(makeReq(), res, next);

      return res;
    };

    expect(run().statusCode).toBeNull();
    expect(run().statusCode).toBeNull();
    expect(next).toHaveBeenCalledTimes(2);

    const refused = run();

    expect(refused.statusCode).toBe(429);
    expect(refused.body).toEqual({ error: 'rateLimited' });
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('адреса считаются раздельно', () => {
    const middleware = rateLimit(new RateLimiter({ limit: 1, windowMs: 60000 }));
    const next = vi.fn();
    const res = makeRes();

    middleware(makeReq({}, '1.1.1.1'), makeRes(), next);
    middleware(makeReq({}, '2.2.2.2'), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBeNull();
  });

  // review-4.md (R4-5): без этой ветки все запросы с уже разорванным сокетом
  // делили бы один бакет '' — та же дыра общего бакета, которую мастер и
  // dedicated закрывают обрывом соединения
  it('запрос без адреса не попадает в общий бакет, а отбивается', () => {
    const middleware = rateLimit(new RateLimiter({ limit: 5, windowMs: 60000 }));
    const next = vi.fn();
    const broken = makeRes();

    middleware({ headers: {}, socket: {} }, broken, next);

    expect(broken.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();

    // и лимит живого клиента при этом не тронут
    const alive = makeRes();

    middleware(makeReq(), alive, next);

    expect(alive.statusCode).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('X-Forwarded-For ключом не становится ни в одном режиме', () => {
    const spoofed = i => makeReq({ 'x-forwarded-for': `10.0.0.${i}` });
    const next = vi.fn();
    const middleware = rateLimit(new RateLimiter({ limit: 1, windowMs: 60000 }));
    const res = makeRes();

    middleware(spoofed(1), makeRes(), next);
    middleware(spoofed(2), res, next);

    expect(res.statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('за прокси ключом становится X-Real-IP', () => {
    const middleware = rateLimit(new RateLimiter({ limit: 1, windowMs: 60000 }), {
      trustProxy: true,
    });
    const next = vi.fn();
    const res = makeRes();

    // один и тот же сокет (Nginx), разные клиенты — разные бакеты
    middleware(makeReq({ 'x-real-ip': '7.7.7.7' }), makeRes(), next);
    middleware(makeReq({ 'x-real-ip': '8.8.8.8' }), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBeNull();

    const repeat = makeRes();

    middleware(makeReq({ 'x-real-ip': '8.8.8.8' }), repeat, next);

    expect(repeat.statusCode).toBe(429);
  });
});
