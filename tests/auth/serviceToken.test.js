import {
  isValidServiceToken,
  requireServiceToken,
} from '../../packages/auth/src/lib/serviceToken.js';

function run(middleware, authorization) {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  const next = vi.fn();

  middleware(
    { headers: authorization === undefined ? {} : { authorization } },
    res,
    next,
  );

  return { res, next };
}

describe('serviceToken', () => {
  it('пустой expected — токен не принимается никогда', () => {
    expect(isValidServiceToken('Bearer ', '')).toBe(false);
    expect(isValidServiceToken('Bearer x', '')).toBe(false);
  });

  it('пустой expected — middleware отвечает 503', () => {
    const { res, next } = run(requireServiceToken(''), 'Bearer x');

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'reportsDisabled' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['нет заголовка', undefined],
    ['не Bearer', 'Basic secret'],
    ['неверный токен', 'Bearer wrong'],
    ['другой длины', 'Bearer secret-but-much-longer'],
  ])('%s — 401', (_, header) => {
    const { res, next } = run(requireServiceToken('secret'), header);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('токены разной длины не бросают', () => {
    expect(() =>
      isValidServiceToken('Bearer a', 'much-longer-secret'),
    ).not.toThrow();
    expect(isValidServiceToken('Bearer a', 'much-longer-secret')).toBe(false);
    expect(isValidServiceToken(42, 'secret')).toBe(false);
  });

  it('верный токен — next()', () => {
    const { res, next } = run(requireServiceToken('secret'), 'Bearer secret');

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
