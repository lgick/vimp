// Env-переопределения серверного конфига (Этап 4 плана standalone-sdk).
// Раньше этот блок жил в master/main.js под условием NODE_ENV=production:
// лобби-мастер в dev работает на дефолтах конфига. Dedicated-серверу так
// нельзя — игру, порт и настройки комнаты он получает только из окружения,
// в том числе локально, — поэтому чтение вынесено сюда и применяется каждым
// входом по своим правилам.

/**
 * Применяет env-переопределения к конфигу мастера.
 * @param {Object} config - Синглтон lib/config.js.
 * @param {Object} [env] - Окружение (по умолчанию process.env).
 */
export function applyMasterEnv(config, env = process.env) {
  if (env.VIMP_DOMAIN) {
    config.set('master:domain', env.VIMP_DOMAIN);
  }

  // порт серверного процесса
  if (env.VIMP_MASTER_PORT) {
    config.set('master:port', Number(env.VIMP_MASTER_PORT));
  }

  // домен central auth-сервиса (Этап B2) — попадает в CSP connect-src, т.к.
  // лобби делает туда прямой fetch (POST /nick)
  if (env.VIMP_AUTH_SERVICE_URL) {
    config.set('master:security:authServiceUrl', env.VIMP_AUTH_SERVICE_URL);
  }

  // корень хранилища игровых пакетов (направление master-game-registry) —
  // в проде это смонтированный том, переживающий пересоздание контейнера
  if (env.VIMP_GAMES_DIR) {
    config.set('master:gameStore:dir', env.VIMP_GAMES_DIR);
  }

  // общий секрет бокса и auth-сервиса для пересылки журнала клиентских
  // ошибок (plan/client-reports)
  if (env.VIMP_CLIENT_REPORTS_TOKEN) {
    config.set('master:clientReports:token', env.VIMP_CLIENT_REPORTS_TOKEN);
  }
}

// минимальная длина VIMP_ROOM_SECRET_KEY — ключ HMAC-SHA256
const ROOM_SECRET_KEY_MIN_BYTES = 32;

/**
 * Ключ секрета комнаты (host-migration, этап 2): roomSecret = HMAC(ключ,
 * roomId:epoch:hostUserId) — им хост доказывает комнату после рестарта
 * мастера. В production обязателен; в dev без него генерируется случайный на
 * время процесса (комнаты после рестарта dev-мастера не восстанавливаются).
 * @param {Object} [env] - Окружение (по умолчанию process.env).
 * @param {Object} opts
 * @param {boolean} opts.isProduction
 * @param {Function} opts.randomBytes - crypto.randomBytes.
 * @returns {{ key: string|Buffer, ephemeral: boolean }}
 */
export function readRoomSecretKey(
  env = process.env,
  { isProduction, randomBytes },
) {
  const key = env.VIMP_ROOM_SECRET_KEY;

  if (key) {
    if (Buffer.byteLength(key) < ROOM_SECRET_KEY_MIN_BYTES) {
      throw new Error(
        `VIMP_ROOM_SECRET_KEY: at least ${ROOM_SECRET_KEY_MIN_BYTES} bytes required`,
      );
    }

    return { key, ephemeral: false };
  }

  if (isProduction) {
    throw new Error('VIMP_ROOM_SECRET_KEY must be set in production');
  }

  return { key: randomBytes(ROOM_SECRET_KEY_MIN_BYTES), ephemeral: true };
}

/**
 * Настройки комнаты dedicated-сервера: VIMP_DEDICATED_ROOM — JSON-объект
 * (map, maxPlayers, roundTime, mapTime, friendlyFire, seed). Мусор в
 * переменной не должен ронять процесс молча — отказ именованный.
 * @param {Object} [env] - Окружение (по умолчанию process.env).
 * @returns {Object} Переопределения комнаты.
 */
export function readDedicatedRoom(env = process.env) {
  if (!env.VIMP_DEDICATED_ROOM) {
    return {};
  }

  let room;

  try {
    room = JSON.parse(env.VIMP_DEDICATED_ROOM);
  } catch (e) {
    throw new Error(`VIMP_DEDICATED_ROOM: invalid JSON — ${e.message}`);
  }

  if (!room || typeof room !== 'object' || Array.isArray(room)) {
    throw new Error('VIMP_DEDICATED_ROOM: expected a JSON object');
  }

  return room;
}
