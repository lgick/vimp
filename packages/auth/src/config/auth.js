import path from 'path';
import { fileURLToPath } from 'url';

// корень репозитория — якорь от расположения файла, не от cwd
const rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

// Разбор VIMP_ADMIN_NICKS (направление master-game-registry, этап 1).
// Отдельная экспортируемая функция, а не выражение внутри объекта: так её
// поведение (регистр, пробелы, пустая строка, хвостовая запятая) покрывается
// юнит-тестом без импорта всего конфига
export const parseAdminNicks = raw =>
  String(raw || '')
    .split(',')
    .map(nick => nick.trim().toLowerCase())
    .filter(Boolean);

export default {
  name: 'VIMP Auth Service',
  protocol: 'http:',
  domain: 'localhost',
  port: 3010,

  // публичный origin сервиса в проде (используется для redirect_uri, которую
  // видят OAuth-провайдеры и браузер жертвы); в dev не задан — callbackUrl()
  // строится из protocol/domain/port выше. Переопределяется VIMP_AUTH_PUBLIC_URL
  publicUrl: '',

  // origin'ы мастеров, которым разрешён CORS на POST /nick и redirect
  // returnUrl (F1/F3 кодревью, plan-readme-md-b-zippy-giraffe.md) —
  // CSV из VIMP_AUTH_ALLOWED_ORIGINS, напр. "https://vimp.example.com".
  // Дефолт — origin мастера из dev-конфига (packages/engine/src/config/master.js)
  allowedOrigins: ['https://localhost:3002'],

  // RS256-ключ подписи JWT (private) + публичная часть отдаётся на /jwks;
  // сгенерировать локально: openssl genrsa -out .keys/jwt.pem 2048 &&
  // openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem
  jwt: {
    privateKeyPath: path.join(rootDir, '.keys', 'jwt.pem'),
    publicKeyPath: path.join(rootDir, '.keys', 'jwt.pub.pem'),
    keyId: 'vimp-auth-1', // kid в JWKS; сменить при ротации ключа
    issuer: 'vimp-auth',
    // F5 кодревью: 15 минут короче типичного матча — flush (PUT rank/state) на
    // границе долгого матча получал 401 и переставал сохраняться; 4 часа с
    // запасом покрывают сессию, при этом токен остаётся короткоживущим
    // относительно возможной компрометации (см. lib/jwt.js verifyIdentityToken)
    expiresIn: '4h',
    pendingExpiresIn: '10m', // токен на выбор ника между OAuth-колбэком и POST /nick
  },

  // подключение к PostgreSQL — по умолчанию из переменных окружения
  // (стандартные PG*), см. docs/en/auth.md
  db: {
    connectionString: process.env.VIMP_AUTH_DATABASE_URL || 'postgres://localhost:5432/vimp_auth',
  },

  // OAuth-провайдеры. B1: только github (см. решение — начать с одного
  // провайдера); google/apple добавляются по тому же паттерну провайдера
  // (getAuthorizationUrl/exchangeCode) в src/oauth/
  oauth: {
    github: {
      clientId: process.env.VIMP_AUTH_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.VIMP_AUTH_GITHUB_CLIENT_SECRET || '',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userApiUrl: 'https://api.github.com/user',
      scope: 'read:user',
    },
  },

  // ограничения ника — переиспользует NAME_REGEXP движка
  // (packages/engine/src/lib/validators.js), продублирован в src/lib/validators.js
  nick: {
    maxLength: 14,
  },

  // server-rating этап 1 (plan/server-rating/stage_1.md, 1.1): rank —
  // единый integer-шаблон для всех game_id, кэш ratings.rank клампится в
  // этот диапазон при пересчёте леджера rank_events
  rank: {
    min: 0,
    max: 1000000,
    // snakes-v3 (stage_2.md, 2.6): maxDelta заменён парой пределов результата
    // игры. maxGameScore — потолок ОДНОЙ игры, maxPoints — потолок суммы
    // склеенных игр в одном запросе. Значения абсолютные и заведомо щедрые:
    // они последняя линия обороны auth, а рабочий предел пер-игровой и живёт
    // на мастере (master:games[]) — auth обслуживает сотни игр, и общий для
    // всех точный предел неверен по построению.
    // Масштаб snakes: очень хорошая десятиминутная жизнь — 1000–1500 очков,
    // экстремум с чередой убийств — 2000–3000, отсюда ×3–5 запас.
    maxGameScore: 10000,
    // = maxGameScore × MERGED_GAMES_PER_WINDOW движка (20): окно склейки на
    // движке — минута, столько игр в неё не влезает.
    //
    // Эта пара СВЯЗАНА с клампом мастера (packages/engine/src/lib/
    // validators.js, clampGameResult): мастер режет по своему потолку и шлёт
    // сюда, и если сюда приходит то, что здесь отклоняется, хост уходит в
    // вечный повтор отклонённого тела. Поднимая maxGameScore отдельной игре
    // на мастере (master:games[].maxGameScore), проверьте, что произведение
    // укладывается в maxPoints
    maxPoints: 200000,

    // Кэш лестницы значений среза, из которой считается место игрока
    // (db/RankDistribution.js). TTL — насколько устаревшим может быть
    // ОКРУЖЕНИЕ игрока (своё значение читается живым), а `distributionSteps`
    // — потолок ступеней на срез: игра, чья лестница в него не уместилась,
    // отвечает глубокому хвосту точным запросом, зато кэш не растёт
    // пропорционально числу игроков за всё время.
    //
    // 30 с — тот же порядок, что и у кэша мест на мастере, который стоял
    // перед этим запросом раньше: место двигают чужие игры, и полминуты его
    // не меняют. 50 000 ступеней — это ~800 КБ на срез в худшем случае
    distributionTtl: 30000,
    distributionSteps: 50000,
  },

  // лимит размера произвольного state (JSONB) игры — поля не валидируются
  // (формат на усмотрение игры), только общий объём
  state: {
    maxBytes: 8192,
  },

  // Админы платформы (направление master-game-registry). Список ников задаёт
  // деплой: VIMP_ADMIN_NICKS="lgick,Admin". Ник глобально уникален и
  // регистронезависим, поэтому список провайдеронезависим — работает и для
  // github, и для будущих google/apple. Пустая строка — законное состояние
  // (админов нет), падать нельзя
  admin: {
    nicks: parseAdminNicks(process.env.VIMP_ADMIN_NICKS),
  },

  // реестр игр платформы (миграция 009_games.sql): ограничения полей заявки
  // разработчика и модерации
  games: {
    // сегмент URL: строчная латиница, цифры и дефис
    idPattern: /^[a-z][a-z0-9-]{1,30}$/,
    // имя npm-пакета, в т.ч. scoped
    packagePattern: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    versionPattern: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/,
    maxPerUser: 20,
    maxNoteLength: 1000,
    maxTitleLength: 60,
    maxUrlLength: 200,
  },

  // server-rating этап 2 (plan/server-rating/stage_2.md, 2.4): диапазон
  // рейтинга хостера — зеркало движкового дефолта (master:rating в
  // packages/engine/src/config/master.js); auth — единственный, кто
  // фактически клампит SUM(host_votes.value) в этот диапазон и решает
  // blocked, поэтому владеет собственной копией, как и rank выше
  rating: {
    min: -10,
    max: 10,
    blockAt: -10,
  },
};
