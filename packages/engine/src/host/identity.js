// Стратегии идентичности хоста: как порт-машина (PortMachine.js) узнаёт,
// под каким ником участник входит в комнату. Прод-лобби доверяет только
// подписанному identity-токену центрального auth-сервиса; standalone- и
// dedicated-контуры мастера не имеют вовсе и пускают гостей по нику из формы.
//
// Контракт стратегии:
//   { params: Array, errorField: string, resolve(data, socketId): Promise<string> }
// params доклеиваются к authSchema.params игры (и в форму клиента, и в
// validateAuth), resolve возвращает проверенный ник или бросает.

import { verifyIdentityToken } from '../lib/jwt.js';
import { isValidName } from '../lib/validators.js';

/**
 * Прод-лобби: ник берётся из claim проверенного identity-токена (Этап B3).
 * @param {Object} deps
 * @param {string} deps.jwksUrl - URL JWKS (прокси мастера).
 * @param {string} deps.issuer - ожидаемый iss токена.
 * @returns {Object} Стратегия идентичности.
 */
export function createTokenIdentity({ jwksUrl, issuer }) {
  // JWKS central auth-сервиса, проксированный мастером (Этап B3), кэшируется
  // на время жизни стратегии — ключ меняется только при ротации
  let jwksPromise = null;

  const getJwks = () => {
    if (!jwksPromise) {
      jwksPromise = fetch(jwksUrl).then(res => {
        if (!res.ok) {
          throw new Error(`jwks: HTTP ${res.status}`);
        }

        return res.json();
      });

      // сбой не должен закэшироваться навсегда — следующий вход попробует снова
      jwksPromise.catch(() => {
        jwksPromise = null;
      });
    }

    return jwksPromise;
  };

  return {
    // токен не поле игровой формы — в authSchema его нет, и validateAuth
    // его не касается: подпись авторитетнее любой схемы
    params: [],
    errorField: 'token',

    // проверяет identity-токен клиента: подпись RS256 по JWKS мастера,
    // issuer, срок годности — возвращает проверенный ник или бросает.
    // Свободный ввод имени в игре не источник ника: он берётся из claim
    async resolve(data) {
      const jwks = await getJwks();
      const payload = await verifyIdentityToken(data.token, { jwks, issuer });

      return payload.nick;
    },
  };
}

/**
 * Гостевой вход (standalone/dedicated): ник — поле формы, которое хост
 * валидирует сам движковым isValidName, без кода игры.
 *
 * Ограничение (принимается осознанно): гостевые ники не уникальны и не
 * защищены от подмены — центральной идентичности в этом контуре нет.
 * @param {Object} [options]
 * @param {string} [options.fallbackPrefix] - префикс ника-заглушки.
 * @returns {Object} Стратегия идентичности.
 */
export function createGuestIdentity({ fallbackPrefix = 'Player_' } = {}) {
  return {
    params: [
      {
        name: 'name',
        value: '',
        options: {
          control: 'text',
          label: 'Name',
          validator: 'isValidName',
          storage: 'playerName',
          required: true,
          maxlength: 15,
        },
      },
    ],
    errorField: 'name',

    // fallback нужен не форме (её ввод отсекает validateAuth по тому же
    // isValidName), а прямым вызовам стратегии — гость без ника всё равно
    // должен получить имя, под которым его увидят остальные
    async resolve(data, socketId) {
      return isValidName(data?.name)
        ? data.name
        : `${fallbackPrefix}${String(socketId).slice(0, 4)}`;
    },
  };
}
