import http from 'http';
import express from 'express';
import config from './config/auth.js';
import jwtLib from './lib/jwt.js';
import oauthState from './lib/oauthState.js';
import { getProvider } from './oauth/index.js';
import createDevLoginHandler from './devLogin.js';
import dbPool from './db/pool.js';
import { startRatingsJob } from './db/ratingsJob.js';
import UserRepository, {
  NickTakenError,
  NickAlreadySetError,
  GameExistsError,
  GameNotFoundError,
  GameForbiddenError,
  GamePublishedError,
  GameLimitError,
  RANK_PERIODS,
} from './UserRepository.js';
import {
  isValidNick,
  isValidGameResult,
  isValidStateSize,
  isValidVoteValue,
  isValidVoteReason,
  clampLimit,
  isValidGameId,
  isValidPackageName,
  isValidGameVersion,
  isValidGameTitle,
  isValidRepoUrl,
  isValidModeratorNote,
  isValidMaxGameScore,
  missingGameField,
} from './lib/validators.js';
import RateLimiter from './lib/rateLimiter.js';
import rateLimit from './lib/rateLimit.js';
// ник модератора снимается на границе маршрута, где смысл читается: общий
// список колонок (GAME_FIELDS) выбирает его для очереди модерации, а третьей
// проекции в репозитории заводить не за чем
import { forAuthor } from './lib/gameViews.js';
import resolveAuthor from './lib/gameAuthor.js';
import isEnvAdmin from './lib/adminRights.js';

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
// заявки разработчика (master-game-registry): регистрация игры и запрос
// версии — редкие действия, частота здесь только против скриптового спама
const gamesLimiter = new RateLimiter({ limit: 5, windowMs: 60000 });

// ключ лимита — адрес клиента за реверс-прокси (Nginx в проде, см.
// deployment.md); разбор и обоснование — в lib/rateLimit.js
const byIp = limiter => rateLimit(limiter, { trustProxy: isProduction });

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

// Выпуск identity-токена (обе точки выпуска — OAuth-колбэк и POST /nick).
// Роль синхронизируется с окружением на каждом входе: список из окружения —
// источник истины, и разжалование должно доезжать до БД без ручного SQL
async function issueIdentityToken(user) {
  // личность читается из БД: обе точки выпуска токена знают id и ник, но не
  // провайдера. Лишнего запроса без VIMP_ADMIN_IDENTITIES не появляется
  const identity = config.admin.identities.length ? await userRepo.getIdentity(user.id) : null;
  const envAdmin = isEnvAdmin(config.admin, {
    nick: user.nick,
    provider: identity?.provider,
    providerUid: identity?.provider_uid,
  });
  const role = await userRepo.syncRole(user.id, envAdmin);

  return jwtLib.signIdentityToken({ sub: user.id, nick: user.nick, role });
}

// Роль берётся из БД, а не из клейма токена: identity-токен живёт 4 часа, и
// разжалование обязано действовать немедленно. Клейм в токене нужен только
// клиенту — показать вкладку «Moderation»
function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const role = await userRepo.getRole(req.user.id);

      if (role !== 'admin') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      req.user.role = role;
      next();
    } catch (err) {
      next(err); // отказ БД — 500 общим обработчиком, не «доступ разрешён»
    }
  });
}

// админ вправе делать то же, что автор игры (запросить версию за него)
async function isAdminUser(userId) {
  const role = await userRepo.getRole(userId);

  return role === 'admin';
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

// GET /dev/login?nick=&returnUrl=... — вход без OAuth-провайдера. Только вне
// прода: в проде маршрут не регистрируется вообще (404), иначе это была бы
// выдача личности по одному GET-запросу
if (!isProduction) {
  app.get(
    '/dev/login',
    createDevLoginHandler({ userRepo, issueIdentityToken, isAllowedReturnUrl, isValidNick }),
  );
}

// GET /oauth/:provider/start?returnUrl=... — редирект на страницу провайдера
app.get('/oauth/:provider/start', byIp(oauthStartLimiter), (req, res) => {
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
      redirectUrl.searchParams.set('token', await issueIdentityToken(user));
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
app.post('/nick', byIp(nickLimiter), async (req, res) => {
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

    res.json({ token: await issueIdentityToken(user) });
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

// ***** РЕЕСТР ИГР (master-game-registry, этап 1) *****
//
// CORS этим ручкам не нужен: браузер лобби ходит в них через прокси мастера,
// как и в rank/state/jwks (прямой fetch из браузера есть только у /nick)

// GET /games — каталог для мастеров: одобренные игры с раздаваемой версией.
// Публичный, как и /leaderboard: список игр платформы и так виден в лобби
app.get('/games', async (req, res) => {
  res.json({ games: await userRepo.listApprovedGames() });
});

// GET /games/mine — заявки вызывающего со статусами и замечаниями модератора
app.get('/games/mine', requireAuth, async (req, res) => {
  const games = await userRepo.listGamesByAuthor(req.user.id);

  res.json({ games: games.map(forAuthor) });
});

// проверяет поля заявки и отвечает своим кодом на каждое; null — всё чисто
function gameInputError({ id, packageName, version, title, repoUrl }) {
  if (id !== undefined && !isValidGameId(id, config.games)) {
    return 'invalidGameId';
  }

  if (packageName !== undefined && !isValidPackageName(packageName, config.games)) {
    return 'invalidPackageName';
  }

  if (version !== undefined && !isValidGameVersion(version, config.games)) {
    return 'invalidVersion';
  }

  if (!isValidGameTitle(title, config.games)) {
    return 'invalidTitle';
  }

  if (!isValidRepoUrl(repoUrl, config.games)) {
    return 'invalidRepoUrl';
  }

  return null;
}

// POST /games — заявка разработчика на новую игру платформы
app.post('/games', requireAuth, byIp(gamesLimiter), async (req, res) => {
  const { id, packageName, title = null, repoUrl = null, version } = req.body || {};
  // gameInputError проверяет ФОРМАТ и пропускает отсутствующее поле (он же
  // обслуживает частичное обновление); присутствие обязательных полей —
  // требование именно этого роута
  const missing = missingGameField({ id, packageName, version });

  if (missing) {
    res.status(400).json({ error: 'badRequest', field: missing });
    return;
  }

  const error = gameInputError({ id, packageName, version, title, repoUrl });

  if (error) {
    res.status(400).json({ error });
    return;
  }

  try {
    const game = await userRepo.createGame({
      id,
      packageName,
      title,
      repoUrl,
      version,
      authorUserId: req.user.id,
    });

    res.status(201).json({ game: forAuthor(game) });
  } catch (err) {
    if (err instanceof GameExistsError) {
      res.status(409).json({ error: 'gameExists' });
      return;
    }

    if (err instanceof GameLimitError) {
      res.status(403).json({ error: 'tooManyGames' });
      return;
    }

    throw err;
  }
});

// POST /games/:id/version — заявка на новую версию уже заведённой игры
app.post('/games/:id/version', requireAuth, byIp(gamesLimiter), async (req, res) => {
  const { version } = req.body || {};

  if (!isValidGameVersion(version, config.games)) {
    res.status(400).json({ error: 'invalidVersion' });
    return;
  }

  try {
    const isAdmin = await isAdminUser(req.user.id);
    const game = await userRepo.requestGameVersion(req.params.id, version, {
      userId: req.user.id,
      isAdmin,
    });

    // админ подаёт версию за чужую игру из той же панели, где ник модератора
    // и так виден: скрывать его от него незачем
    res.json({ game: isAdmin ? game : forAuthor(game) });
  } catch (err) {
    if (err instanceof GameNotFoundError) {
      res.status(404).json({ error: 'unknownGame' });
      return;
    }

    if (err instanceof GameForbiddenError) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    throw err;
  }
});

// DELETE /games/:id — удаление игры из реестра. Один маршрут на обе роли:
// право решает не путь, а роль из БД (тот же приём, что у
// POST /games/:id/version). Админ удаляет любую игру, автор — свою и
// только не раздаваемую
app.delete('/games/:id', requireAuth, byIp(gamesLimiter), async (req, res) => {
  try {
    const isAdmin = await isAdminUser(req.user.id);
    const game = await userRepo.deleteGame(req.params.id, {
      userId: req.user.id,
      isAdmin,
    });

    res.json({ game: isAdmin ? game : forAuthor(game) });
  } catch (err) {
    if (err instanceof GameNotFoundError) {
      res.status(404).json({ error: 'unknownGame' });
      return;
    }

    if (err instanceof GamePublishedError) {
      res.status(409).json({ error: 'gamePublished' });
      return;
    }

    if (err instanceof GameForbiddenError) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    throw err;
  }
});

// статусы игры в реестре; отдельного 'testing' нет намеренно — «игра на
// тесте» это наличие pending_version при любой из этих отметок
const GAME_STATUSES = ['pending', 'approved', 'rejected', 'disabled'];

// GET /admin/games — очередь модерации целиком
app.get('/admin/games', requireAdmin, async (req, res) => {
  res.json({ games: await userRepo.listAllGames() });
});

// PATCH /admin/games/:id — решение модератора
app.patch('/admin/games/:id', requireAdmin, async (req, res) => {
  const { status, version, pendingVersion, note, maxGameScore, authorNick } = req.body || {};

  if (status !== undefined && !GAME_STATUSES.includes(status)) {
    res.status(400).json({ error: 'badRequest' });
    return;
  }

  if (version !== undefined && version !== null && !isValidGameVersion(version, config.games)) {
    res.status(400).json({ error: 'invalidVersion' });
    return;
  }

  if (
    pendingVersion !== undefined && pendingVersion !== null &&
    !isValidGameVersion(pendingVersion, config.games)
  ) {
    res.status(400).json({ error: 'invalidVersion' });
    return;
  }

  if (!isValidModeratorNote(note, config.games)) {
    res.status(400).json({ error: 'badRequest' });
    return;
  }

  if (
    maxGameScore !== undefined && maxGameScore !== null &&
    !isValidMaxGameScore(maxGameScore, config.rank)
  ) {
    res.status(400).json({ error: 'invalidMaxGameScore' });
    return;
  }

  // игра ищется ДО разбора авторства: несуществующая игра обязана отвечать
  // 'unknownGame', а не 'unknownUser', и лишнего запроса в БД на заведомо
  // провальном пути быть не должно
  const game = await userRepo.getGame(req.params.id);

  if (!game) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  // авторство: в теле едет ник, в колонку — id
  const author = await resolveAuthor(authorNick, nick => userRepo.findByNick(nick));

  if (!author.ok) {
    res.status(author.status).json({ error: author.error });
    return;
  }

  const patch = {
    status, version, pendingVersion, note, maxGameScore,
    authorUserId: author.authorUserId,
  };

  // самый частый путь одобрения: админ шлёт только status='approved', а
  // поднять версию на раздачу и очистить очередь — работа сервиса, не
  // клиента (иначе одобрение требовало бы двух полей и умело бы разъехаться)
  if (status === 'approved' && version === undefined) {
    patch.version = game.pendingVersion ?? game.version;
    patch.pendingVersion = null;
  }

  const updated = await userRepo.moderateGame(req.params.id, patch, req.user.id);

  // решение могло снять с раздачи последнюю игру платформы. Отказом это не
  // является — лобби остаётся рабочим, вход и модерация от каталога не
  // зависят, — но комнату создавать становится не на чем, и узнать об этом
  // модератор должен здесь, а не от игроков
  if ((await userRepo.countApprovedGames()) === 0) {
    res.json({ game: updated, warning: 'catalogEmpty' });
    return;
  }

  res.json({ game: updated });
});

// GET /jwks — публичный ключ для верификации identity-токена хостом
app.get('/jwks', (req, res) => {
  res.json(jwtLib.getJwks());
});

// rank-periods: срез лидерборда, ?period=day|month|all. Отсутствие — 'all',
// то есть ровно то поведение, что было до периодов: старый клиент (и любой
// сторонний) продолжает получать рейтинг за всё время. Мусорное значение —
// 400, а не молчаливый откат на 'all': запрос за «неделю» лучше отклонить,
// чем ответить не тем срезом и дать нарисовать его под чужим заголовком.
function readPeriod(raw) {
  if (raw === undefined) {
    return 'all';
  }

  return RANK_PERIODS.includes(raw) ? raw : null;
}

// GET /leaderboard — публичный (без requireAuth) топ-N рейтинга игры
// (lobby-page-plan): показывается всем в лобби до логина, как /host-rating/:id
app.get('/leaderboard', async (req, res) => {
  const gameId = req.query.game;

  // ?game=a&game=b даёт массив (code review) — без этой проверки запрос
  // к pg падает в необёрнутом async-роуте и виснет без ответа
  if (!gameId || typeof gameId !== 'string') {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  const limit = clampLimit(req.query.limit, 10, 100);
  const period = readPeriod(req.query.period);

  if (!period) {
    res.status(400).json({ error: 'badPeriod' });
    return;
  }

  res.json(await userRepo.getLeaderboard(gameId, limit, period));
});

// GET /placement — позиция вызывающего в рейтинге игры (lobby-page-plan)
app.get('/placement', requireAuth, async (req, res) => {
  const gameId = req.query.game;

  if (!gameId || typeof gameId !== 'string') {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  const period = readPeriod(req.query.period);

  if (!period) {
    res.status(400).json({ error: 'badPeriod' });
    return;
  }

  res.json(await userRepo.getPlacement(req.user.id, gameId, period));
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

  // snakes-v3 (stage_2.md, 2.5): тело — результат игры { points, best }.
  // TODO(удалить после 2026-10-01): `delta` принимается как алиас points
  // ровно на одну версию, чтобы не ронять хосты старой сборки; best у них
  // нет, и одиночной игрой считается сам points
  const points = Number(req.body?.points ?? req.body?.delta);
  const best = Number(req.body?.best ?? points);

  if (!isValidGameResult(points, best, config.rank)) {
    res.status(400).json({ error: 'invalidRank' });
    return;
  }

  await userRepo.recordGameResult(
    req.user.id,
    gameId,
    { points, best },
    readAttribution(req.body),
  );

  // пересчитанный rank больше не считается на записи (all-time — суточный
  // снимок), и возвращать его здесь было бы ложью
  res.json({ ok: true });
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

// Финальный обработчик: без него отказ БД уходил в дефолтный обработчик
// Express — 500 без единой строки в журнале сервиса. Тело наружу
// обезличенное (стек в ответе не место), а requireAdmin с его next(err) на
// этот обработчик и рассчитан
app.use((err, req, res, next) => {
  console.error(`[auth] ${req.method} ${req.path} failed:`, err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({ error: 'internal' });
});

const server = http.createServer(app);

// snakes-v3 (stage_2.md, 2.4): суточный пересчёт all-time-снимка
startRatingsJob(dbPool.getPool());

// уборка кэша распределений (db/RankDistribution.js): Map растёт по числу
// увиденных (игра, срез), а популярность игр меняется. Интервал — тот же
// TTL, дольше протухшего ключа он не живёт. .unref(), чтобы не держать
// процесс
const distributionSweep = setInterval(
  () => userRepo.sweepDistributions(),
  config.rank.distributionTtl,
);

distributionSweep.unref?.();

// Незанятый админский ник — это открытая дверь: права привязаны к строке, и
// первый, кто зарегистрируется под ней, получит admin. Печатается один раз
// при старте (во всех режимах, включая прод); VIMP_ADMIN_IDENTITIES снимает
// вопрос. Вторая строка (nick -> provider:uid) даёт готовое значение
// переменной, иначе его пришлось бы доставать SQL-ом из прода
async function warnOnFreeAdminNicks() {
  if (config.admin.identities.length > 0 || config.admin.nicks.length === 0) {
    return;
  }

  for (const nick of config.admin.nicks) {
    const user = await userRepo.findByNick(nick).catch(() => null);

    if (!user) {
      console.warn(
        `[admin] nick "${nick}" from VIMP_ADMIN_NICKS is not registered yet — ` +
          'whoever signs up with it first becomes an admin. Pin the account ' +
          'with VIMP_ADMIN_IDENTITIES=<provider>:<uid> once it exists',
      );
      continue;
    }

    console.log(
      `[admin] "${nick}" -> ${user.provider}:${user.provider_uid} ` +
        '(value for VIMP_ADMIN_IDENTITIES)',
    );
  }
}

server.listen(config.port, () => {
  console.info(`
    Auth service is running for ${env.NODE_ENV || 'development'} mode.
    Listening on http://localhost:${config.port}
  `);

  // отказ БД не должен мешать старту сервиса
  warnOnFreeAdminNicks().catch(() => null);

  if (!isProduction) {
    // Ссылки на обе роли сразу: роль даёт VIMP_ADMIN_NICKS, и без готовой
    // ссылки «а под кем я сейчас зашёл» выясняется только по 403 из панели
    // модерации. Ник админа берётся из самого списка, поэтому баннер не
    // может разойтись с конфигом
    const devLoginUrl = nick =>
      `http://localhost:${config.port}/dev/login` +
      `?nick=${encodeURIComponent(nick)}&returnUrl=${config.allowedOrigins[0]}/`;
    // Написание берётся из САМОЙ переменной, а не из config.admin.nicks:
    // те приведены к нижнему регистру для сравнения, а dev-логин заводит
    // личность по provider_uid = ник, и регистр там значим. Ссылка с чужим
    // написанием создала бы вторую личность и упёрлась в занятый ник
    const adminNick = String(env.VIMP_ADMIN_NICKS || '').split(',')[0].trim();

    console.warn(
      `    DEV login enabled (role comes from VIMP_ADMIN_NICKS):\n` +
        `      user:  ${devLoginUrl('Player1')}\n` +
        (adminNick
          ? `      admin: ${devLoginUrl(adminNick)}\n`
          : '      admin: set VIMP_ADMIN_NICKS=<nick> to get one\n'),
    );
  }
});

export default app;
