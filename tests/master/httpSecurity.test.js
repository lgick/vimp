import { describe, it, expect, vi } from 'vitest';
import { denySourceMaps } from '../../packages/engine/src/master/httpSecurity.js';

// Скрытые source maps (plan/client-reports, этап 4) бокс читает сам, но в
// проде наружу не отдаёт

const fakeRes = () => {
  const res = {
    code: 200,
    body: null,
    status(code) {
      res.code = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };

  return res;
};

describe('denySourceMaps', () => {
  it('прод: *.map → 404, next не зовётся', () => {
    const res = fakeRes();
    const next = vi.fn();

    denySourceMaps({ isProduction: true })({ path: '/assets/a.js.map' }, res, next);

    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: 'notFound' });
    expect(next).not.toHaveBeenCalled();
  });

  it('прод: сам бандл пропускается', () => {
    const res = fakeRes();
    const next = vi.fn();

    denySourceMaps({ isProduction: true })({ path: '/assets/a.js' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(200);
  });

  it('dev: карты пропускаются (их раздаёт Vite для DevTools)', () => {
    const res = fakeRes();
    const next = vi.fn();

    denySourceMaps({ isProduction: false })({ path: '/assets/a.js.map' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(200);
  });
});
