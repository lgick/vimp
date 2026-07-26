import http from 'http';
import express from 'express';
import config from './config/auth.js';
import jwtLib from './lib/jwt.js';
import oauthState from './lib/oauthState.js';
import { getProvider } from './oauth/index.js';
import dbPool from './db/pool.js';
import UserRepository, { NickTakenError, NickAlreadySetError } from './UserRepository.js';
import {
  isValidNick,
  isValidRankDelta,
  isValidStateSize,
  isValidVoteValue,
  isValidVoteReason,
} from './lib/validators.js';
import RateLimiter from './lib/rateLimiter.js';

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

if (isProduction) {
  if (env.VIMP_AUTH_PORT) {
    config.port = Number(env.VIMP_AUTH_PORT);
  }

  // публичный origin сервиса (F2) — без него redirect_uri уходит провайдерам
  // как http://localhost:PORT и OAuth ломается в проде
  if (!env.VIMP_AUTH_PUBLIC_URL) {
    console.error(`
      ERROR: VIMP_AUTH_PUBLIC_URL must be set in the .env file for production.
    `);
    process.exit(1);
  }

  config.publicUrl = env.VIMP_AUTH_PUBLIC_URL;

  // allowlist origin'ов мастеров (F1/F3) — без него CORS на /nick закрыт для
  // всех, а returnUrl/redirect отклоняется целиком
  if (!env.VIMP_AUTH_ALLOWED_ORIGINS) {
    console.error(`
      ERROR: VIMP_AUTH_ALLOWED_ORIGINS must be set in the .env file for production.
    `);
    process.exit(1);
  }

  config.allowedOrigins = env.VIMP_AUTH_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);

  if (!env.VIMP_AUTH_STATE_SECRET) {
    console.error(`
      ERROR: VIMP_AUTH_STATE_SECRET must be set in the .env file for production.
    `);
    process.exit(1);
  }

  if (!env.VIMP_AUTH_GITHUB_CLIENT_ID || !env.VIMP_AUTH_GITHUB_CLIENT_SECRET) {
    console.error(`
      ERROR: VIMP_AUTH_GITHUB_CLIENT_ID and VIMP_AUTH_GITHUB_CLIENT_SECRET must be set
      in the .env file for production.
    `);
    process.exit(1);
  }
} else if (env.VIMP_AUTH_ALLOWED_ORIGINS) {
  config.allowedOrigins = env.VIMP_AUTH_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
}

const userRepo = new UserRepository(dbPool.getPool());

function callbackUrl(provider) {
  const base = config.publicUrl || `${config.protocol}//${config.domain}:${config.port}`;

  return `${base}/oauth/${provider}/callback`;
}

// проверяет, что origin returnUrl в allowlist (F3: без этого — open redirect,
// ворующий identity-токен через чужой домен). В dev с пустым allowlist ничего
// не разрешает — allowlist нужно явно задать даже локально
function isAllowedReturnUrl(returnUrl) {
  try {
    return config.allowedOrigins.includes(new URL(returnUrl).origin);
  } catch {
    return false;
  }
}

// F12: ограничение перебора/сквоттинга ников и OAuth-запуска по IP
// (тот же паттерн, что и мастеровый RateLimiter, см. lib/rateLimiter.js)
const nickLimiter = new RateLimiter({ limit: 5, windowMs: 60000 });
const oauthStartLimiter = new RateLimiter({ limit: 20, windowMs: 60000 });

// IP клиента за реверс-прокси (Nginx в проде, см. deployment.md) — тот же
// приём, что и в packages/engine/src/master/SignalingServer.js: без
// app.set('trust proxy', ...) req.ip у Express равен адресу самого Nginx,
// и rate-limit стал бы одним общим лимитом на всех клиентов сразу
function clientIp(req) {
  const header = req.headers['x-forwarded-for'];

  return header ? header.split(',')[0].trim() : req.socket.remoteAddress;
}

function rateLimit(limiter) {
  return (req, res, next) => {
    if (!limiter.consume(clientIp(req))) {
      res.status(429).json({ error: 'rateLimited' });
      return;
    }

    next();
  };
}

// извлекает и проверяет Bearer identity-токен, кладёт { id, nick } в req.user
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const payload = jwtLib.verifyToken(token);

    if (payload.pending) {
      res.status(401).json({ error: 'nickRequired' });
      return;
    }

    req.user = { id: Number(payload.sub), nick: payload.nick };
    next();
  } catch {
    res.status(401).json({ error: 'invalidToken' });
  }
}

const app = express();

app.use(express.json({ limit: '16kb' }));

// CORS для POST /nick (F1) — вызывается прямым fetch из браузера лобби,
// origin которого отличается от auth-сервиса; остальные ручки идут через
// прокси мастера (JwksProxy/PlayerDataProxy) и CORS не требуют
app.use('/nick', (req, res, next) => {
  const origin = req.get('origin');

  if (origin && config.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'authorization, content-type');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

// GET /oauth/:provider/start?returnUrl=... — редирект на страницу провайдера
app.get('/oauth/:provider/start', rateLimit(oauthStartLimiter), (req, res) => {
  const { provider: providerName } = req.params;
  const returnUrl = req.query.returnUrl;

  if (typeof returnUrl !== 'string' || !returnUrl) {
    res.status(400).json({ error: 'returnUrlRequired' });
    return;
  }

  if (!isAllowedReturnUrl(returnUrl)) {
    res.status(400).json({ error: 'returnUrlNotAllowed' });
    return;
  }

  try {
    const provider = getProvider(providerName);
    const state = oauthState.encodeState({ returnUrl });

    res.redirect(provider.getAuthorizationUrl(state, callbackUrl(providerName)));
  } catch {
    res.status(404).json({ error: 'unknownProvider' });
  }
});

// GET /oauth/:provider/callback — обмен code, поиск/создание пользователя,
// редирект обратно на returnUrl с identity- или pending-токеном
app.get('/oauth/:provider/callback', async (req, res) => {
  const { provider: providerName } = req.params;
  const { code, state } = req.query;

  let decodedState;

  try {
    decodedState = oauthState.decodeState(state);
  } catch {
    res.status(400).json({ error: 'invalidState' });
    return;
  }

  // F3: state подписан сервисом, но подделать сам returnUrl мог start-запрос
  // до появления проверки выше — перепроверяем на выходе на случай будущих
  // источников state (напр. предыдущей версии токена, ещё не истёкшей)
  if (!isAllowedReturnUrl(decodedState.returnUrl)) {
    res.status(400).json({ error: 'returnUrlNotAllowed' });
    return;
  }

  try {
    const provider = getProvider(providerName);
    const { providerUid } = await provider.exchangeCode(code, callbackUrl(providerName));
    const user = await userRepo.findOrCreateByProvider(providerName, providerUid);

    const redirectUrl = new URL(decodedState.returnUrl);

    if (user.nick) {
      redirectUrl.searchParams.set(
        'token',
        jwtLib.signIdentityToken({ sub: user.id, nick: user.nick }),
      );
    } else {
      redirectUrl.searchParams.set('pendingToken', jwtLib.signPendingToken({ sub: user.id }));
    }

    res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[oauth callback]', err);
    res.status(502).json({ error: 'oauthFailed' });
  }
});

// POST /nick { nick } — первый вход: привязывает глобально уникальный ник
// к pending-токену и выдаёт полноценный identity-токен
app.post('/nick', rateLimit(nickLimiter), async (req, res) => {
  const header = req.get('authorization') || '';
  const pendingToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const { nick } = req.body || {};

  if (!pendingToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!isValidNick(nick)) {
    res.status(400).json({ error: 'invalidNick' });
    return;
  }

  let payload;

  try {
    payload = jwtLib.verifyToken(pendingToken);
  } catch {
    res.status(401).json({ error: 'invalidToken' });
    return;
  }

  // F6: только pending-токен может задавать ник — identity-токен уже
  // указывает на существующий ник, иначе POST /nick становится способом
  // переименования (см. plan-readme-md-b-zippy-giraffe.md)
  if (!payload.pending) {
    res.status(403).json({ error: 'nickAlreadySet' });
    return;
  }

  try {
    const user = await userRepo.setNick(Number(payload.sub), nick);

    res.json({ token: jwtLib.signIdentityToken({ sub: user.id, nick: user.nick }) });
  } catch (err) {
    if (err instanceof NickTakenError) {
      res.status(409).json({ error: 'nickTaken' });
      return;
    }

    if (err instanceof NickAlreadySetError) {
      res.status(403).json({ error: 'nickAlreadySet' });
      return;
    }

    throw err;
  }
});

// GET /jwks — публичный ключ для верификации identity-токена хостом
app.get('/jwks', (req, res) => {
  res.json(jwtLib.getJwks());
});

app.get('/rank', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  res.json({ rank: await userRepo.getRank(req.user.id, gameId) });
});

// server-rating этап 1 (stage_1.md): извлекает атрибуцию записи к
// серверу/сессии из тела запроса — мастер проставляет её из проверенного при
// register_host hosterUserId (не тело от хоста, кодревью №1); опциональна
// (отсутствие не отклоняется, событие просто без хостера). Number.isInteger +
// `> 0` (не Number.isFinite, кодревью, мелкая находка) — явный
// `hosterUserId: null` иначе давал бы 0 и атрибутировал к несуществующему user 0
function readAttribution(body) {
  const rawHosterUserId = Number(body?.hosterUserId);
  const hosterUserId =
    Number.isInteger(rawHosterUserId) && rawHosterUserId > 0 ? rawHosterUserId : null;
  const sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : null;

  return { hosterUserId, sessionId };
}

app.put('/rank', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  // stage_1.md: PUT /rank теперь принимает дельту матча, не абсолют
  const delta = Number(req.body?.delta);

  if (!isValidRankDelta(delta, config.rank.maxDelta)) {
    res.status(400).json({ error: 'invalidRank' });
    return;
  }

  const rank = await userRepo.upsertRank(req.user.id, gameId, delta, readAttribution(req.body));

  res.json({ rank });
});

app.get('/state', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  res.json({ state: await userRepo.getState(req.user.id, gameId) });
});

app.put('/state', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  const state = req.body?.state ?? {};

  // F11: state — непрозрачный JSON игры, но должен остаться объектом (не
  // массив/строка/число) — тело в целом уже ограничено express.json({ limit })
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    res.status(400).json({ error: 'invalidState' });
    return;
  }

  if (!isValidStateSize(state, config.state.maxBytes)) {
    res.status(400).json({ error: 'stateTooLarge' });
    return;
  }

  await userRepo.upsertState(req.user.id, gameId, state, readAttribution(req.body));
  res.json({ ok: true });
});

// server-rating этап 2 (stage_2.md): собственный рейтинг хостера, каким его
// видит сам хостер (для проверки блокировки при регистрации комнаты мастером)
app.get('/host-rating', requireAuth, async (req, res) => {
  res.json(await userRepo.getHostRating(req.user.id));
});

// публичный (без авторизации) рейтинг хостера — server-rating этап 3
// (stage_3.md): мастер опрашивает его периодически для кэша GET /servers, не
// держа Bearer-токен конкретного хостера между запросами; значение и так
// публично показывается в лобби, секретов тут нет
app.get('/host-rating/:hosterUserId', async (req, res) => {
  const hosterUserId = Number(req.params.hosterUserId);

  if (!Number.isInteger(hosterUserId)) {
    res.status(400).json({ error: 'badRequest' });
    return;
  }

  res.json(await userRepo.getHostRating(hosterUserId));
});

// голос гостя за/против хостера комнаты; req.user — голосующий (из его
// Bearer), :hosterUserId — цель голоса (не может голосовать сам за себя —
// это отдельный источник спойлинга собственного рейтинга)
app.put('/host-rating/:hosterUserId', requireAuth, async (req, res) => {
  const hosterUserId = Number(req.params.hosterUserId);
  const { value, reason } = req.body || {};

  if (!Number.isInteger(hosterUserId)) {
    res.status(400).json({ error: 'badRequest' });
    return;
  }

  if (!isValidVoteValue(value)) {
    res.status(400).json({ error: 'invalidVote' });
    return;
  }

  if (hosterUserId === req.user.id) {
    res.status(403).json({ error: 'selfVote' });
    return;
  }

  if (!isValidVoteReason(reason)) {
    res.json({ counted: false, ...(await userRepo.getHostRating(hosterUserId)) });
    return;
  }

  res.json(await userRepo.voteHost(hosterUserId, req.user.id, value, reason.trim()));
});

const server = http.createServer(app);

server.listen(config.port, () => {
  console.info(`
    Auth service is running for ${env.NODE_ENV || 'development'} mode.
    Listening on http://localhost:${config.port}
  `);
});

export default app;
