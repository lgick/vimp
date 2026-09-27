import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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

describe('denySourceMaps: процентное кодирование и регистр', () => {
  it.each([
    '/assets/a.js.%6dap',
    '/assets/a.js%2Emap',
    '/assets/a.js.MAP',
    '/games/tanks/0.23.0/client-x.js.%6Dap',
  ])('прод: %s → 404, next не зовётся', reqPath => {
    const res = fakeRes();
    const next = vi.fn();

    denySourceMaps({ isProduction: true })({ path: reqPath }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(404);
  });

  it('прод: битая процентная последовательность уходит дальше (её отвергнет send)', () => {
    const res = fakeRes();
    const next = vi.fn();

    denySourceMaps({ isProduction: true })({ path: '/assets/%E0%A4%A.js' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(200);
  });

  it('dev: закодированная карта пропускается', () => {
    const res = fakeRes();
    const next = vi.fn();

    denySourceMaps({ isProduction: false })({ path: '/assets/a.js.%6dap' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// настоящий express + express.static: send раскодирует путь сам, и именно
// эту связку обходил старый denySourceMaps
describe('denySourceMaps + express.static', () => {
  let dir;
  let server;
  let base;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vimp-maps-'));
    await fs.writeFile(path.join(dir, 'a.js'), 'console.log(1);');
    await fs.writeFile(path.join(dir, 'a.js.map'), '{"version":3}');

    const app = express();

    app.use(denySourceMaps({ isProduction: true }));
    app.use(express.static(dir));

    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });

    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(['/a.js.map', '/a.js.%6dap', '/a.js%2Emap'])('%s → 404', async reqPath => {
    const res = await fetch(`${base}${reqPath}`);

    expect(res.status).toBe(404);
  });

  it('/a.js → 200', async () => {
    const res = await fetch(`${base}/a.js`);

    expect(res.status).toBe(200);
  });
});
