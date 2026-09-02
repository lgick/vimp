import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import createDevLoginHandler from '../../packages/auth/src/devLogin.js';
import { isValidNick } from '../../packages/auth/src/lib/validators.js';
import { NickTakenError } from '../../packages/auth/src/UserRepository.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ORIGIN = 'https://localhost:3002';

// подписывает тем же способом, что main.js issueIdentityToken, но одноразовым
// ключом — тест не зависит от .keys/ на диске (как tests/auth/jwt.test.js)
const issueIdentityToken = ({ id, nick }) =>
  jwt.sign({ nick, role: 'user' }, privateKey, {
    subject: String(id),
    algorithm: 'RS256',
    issuer: 'vimp-auth',
    expiresIn: '4h',
  });

const isAllowedReturnUrl = returnUrl => {
  try {
    return new URL(returnUrl).origin === ORIGIN;
  } catch {
    return false;
  }
};

function createRes() {
  return {
    redirect: vi.fn(),
    status: vi.fn(function () {
      return this;
    }),
    json: vi.fn(),
  };
}

function createHandler(userRepo) {
  return createDevLoginHandler({ userRepo, issueIdentityToken, isAllowedReturnUrl, isValidNick });
}

describe('devLogin', () => {
  it('редиректит на returnUrl с подписанным identity-токеном', async () => {
    const userRepo = {
      findOrCreateByProvider: vi.fn(async () => ({ id: 7, nick: 'Player1' })),
      setNick: vi.fn(),
    };
    const res = createRes();

    await createHandler(userRepo)(
      { query: { nick: 'Player1', returnUrl: `${ORIGIN}/` } },
      res,
    );

    expect(userRepo.findOrCreateByProvider).toHaveBeenCalledWith('dev', 'Player1');
    expect(res.status).not.toHaveBeenCalled();

    const url = new URL(res.redirect.mock.calls[0][0]);
    const payload = jwt.verify(url.searchParams.get('token'), publicKey, {
      algorithms: ['RS256'],
      issuer: 'vimp-auth',
    });

    expect(url.origin).toBe(ORIGIN);
    expect(payload.nick).toBe('Player1');
    expect(payload.sub).toBe('7');
  });

  it('задаёт ник только при первом входе', async () => {
    const fresh = {
      findOrCreateByProvider: vi.fn(async () => ({ id: 8, nick: null })),
      setNick: vi.fn(),
    };
    const returning = {
      findOrCreateByProvider: vi.fn(async () => ({ id: 8, nick: 'Player2' })),
      setNick: vi.fn(),
    };
    const req = { query: { nick: 'Player2', returnUrl: `${ORIGIN}/` } };

    await createHandler(fresh)(req, createRes());
    await createHandler(returning)(req, createRes());

    expect(fresh.setNick).toHaveBeenCalledWith(8, 'Player2');
    expect(returning.setNick).not.toHaveBeenCalled();
  });

  it('занятый ник (другой регистр) — 409, пустая строка пользователя удалена', async () => {
    // индекс уникальности стоит на lower(nick): вход под 'admin' при живом
    // 'Admin' создаёт строку без ника и бьётся об него в setNick. Такая
    // строка не должна остаться — иначе повторный вход даёт 500 навсегда
    const userRepo = {
      findOrCreateByProvider: vi.fn(async () => ({ id: 9, nick: null })),
      setNick: vi.fn(async () => {
        throw new NickTakenError('admin');
      }),
      deleteIfAnonymous: vi.fn(async () => true),
    };
    const res = createRes();

    await createHandler(userRepo)(
      { query: { nick: 'admin', returnUrl: `${ORIGIN}/` } },
      res,
    );

    expect(userRepo.deleteIfAnonymous).toHaveBeenCalledWith(9);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'nickTaken' });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('провал уборки не молчит: 409 остаётся, но отказ попадает в лог', async () => {
    // если DELETE не прошёл, ядовитая строка осталась и следующий вход тем
    // же ником снова даст 500 — единственный след этого должен быть в логе
    const userRepo = {
      findOrCreateByProvider: vi.fn(async () => ({ id: 9, nick: null })),
      setNick: vi.fn(async () => {
        throw new NickTakenError('admin');
      }),
      deleteIfAnonymous: vi.fn(async () => {
        throw new Error('db is down');
      }),
    };
    const res = createRes();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createHandler(userRepo)(
      { query: { nick: 'admin', returnUrl: `${ORIGIN}/` } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(error).toHaveBeenCalledWith('[dev login] cleanup', expect.any(Error));

    error.mockRestore();
  });

  it('произвольный сбой — по-прежнему 500, строку пользователя не трогает', async () => {
    const userRepo = {
      findOrCreateByProvider: vi.fn(async () => ({ id: 9, nick: null })),
      setNick: vi.fn(async () => {
        throw new Error('db is down');
      }),
      deleteIfAnonymous: vi.fn(),
    };
    const res = createRes();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createHandler(userRepo)(
      { query: { nick: 'Player3', returnUrl: `${ORIGIN}/` } },
      res,
    );

    expect(userRepo.deleteIfAnonymous).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'devLoginFailed' });

    error.mockRestore();
  });

  it('отклоняет невалидный ник, ничего не записав', async () => {
    const userRepo = { findOrCreateByProvider: vi.fn(), setNick: vi.fn() };
    const res = createRes();

    await createHandler(userRepo)(
      { query: { nick: '#bad nick#', returnUrl: `${ORIGIN}/` } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalidNick' });
    expect(userRepo.findOrCreateByProvider).not.toHaveBeenCalled();
  });

  it('отклоняет returnUrl с чужого origin (открытый редирект с токеном)', async () => {
    const userRepo = { findOrCreateByProvider: vi.fn(), setNick: vi.fn() };
    const res = createRes();

    await createHandler(userRepo)(
      { query: { nick: 'Player1', returnUrl: 'https://evil.example/' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'returnUrlNotAllowed' });
    expect(res.redirect).not.toHaveBeenCalled();
    expect(userRepo.findOrCreateByProvider).not.toHaveBeenCalled();
  });
});
