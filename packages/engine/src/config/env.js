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

  // список игр-плагинов мастера (Этап A2), по образцу остальных *_MATRIX
  // env-переопределений — JSON-массив {id, package, version}
  if (env.GAMES_MATRIX) {
    config.set('master:games', JSON.parse(env.GAMES_MATRIX));
  }
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
