// Роутер прямых ссылок (host-migration, этап 3). Три вида URL лобби-режима:
//
//   без hash              — лобби (все игры)
//   #/<gameId>            — быстрая игра: оптимальная комната игры
//   #/<gameId>/<roomId>   — прямой вход в комнату
//
// Маршрут живёт в hash: страница одна (SPA), сервер про маршруты не знает, а
// OAuth-возврат hash сохраняет (returnUrl LobbyAuthModel.loginUrl). Решения
// «что делать с маршрутом» и «куда уходить из комнаты» — чистые функции:
// main.js исполняется при импорте, и проверить ветвление внутри него нечем.

import { isValidGameId } from '../../lib/gameId.js';
import { isValidRoomId } from '../../lib/roomId.js';
import { isGameAvailable } from './pickActiveGame.js';

const NONE = Object.freeze({ kind: 'none' });

/**
 * Разбирает hash страницы. Чужие hash (`#auth`, пустой, мусор) — `none`:
 * роутер их не трогает.
 * @param {string} hash - location.hash (с `#` или без).
 * @returns {{kind: 'room', gameId: string, roomId: string}
 *   | {kind: 'game', gameId: string} | {kind: 'none'}}
 */
export function parseRoute(hash) {
  if (typeof hash !== 'string') {
    return NONE;
  }

  const body = hash.startsWith('#') ? hash.slice(1) : hash;

  if (!body.startsWith('/')) {
    return NONE;
  }

  // ссылку набирают и руками: регистр и хвостовой слэш не повод для отказа
  const parts = body.slice(1).toLowerCase().split('/');

  if (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop();
  }

  const [gameId, roomId] = parts;

  if (!isValidGameId(gameId) || parts.length > 2) {
    return NONE;
  }

  if (parts.length === 1) {
    return { kind: 'game', gameId };
  }

  return isValidRoomId(roomId) ? { kind: 'room', gameId, roomId } : NONE;
}

/**
 * @param {string} gameId
 * @param {string} roomId
 * @returns {string} hash-часть ссылки на комнату.
 */
export function formatRoomLink(gameId, roomId) {
  return `#/${gameId}/${roomId}`;
}

/**
 * @param {string} gameId
 * @returns {string} hash-часть ссылки быстрой игры.
 */
export function formatGameLink(gameId) {
  return `#/${gameId}`;
}

/**
 * @param {string} hashPart - `#/…` или '' (лобби).
 * @param {Location} [loc]
 * @returns {string} Абсолютная ссылка для буфера обмена.
 */
export function absoluteLink(hashPart, loc = window.location) {
  return `${loc.origin}${loc.pathname}${hashPart}`;
}

/**
 * Меняет адрес без перезагрузки и без записи в историю: «назад» не должен
 * возвращать в комнату, из которой ушли. Query отбрасывается (там бывают
 * только токены OAuth-возврата, они уже прочитаны).
 * @param {string} hashPart - `#/…` или '' (лобби).
 */
export function setRoute(hashPart) {
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${hashPart}`,
  );
}

/**
 * Перезагрузка на маршрут. replace() с одним только другим hash страницу не
 * перезагружает — поэтому явный reload() следом.
 * @param {string} hashPart - `#/…` или '' (лобби).
 */
export function reloadTo(hashPart) {
  setRoute(hashPart);
  window.location.reload();
}

/**
 * Играбельна ли игра в каталоге вкладки.
 * @param {Map<string, Object>} catalog - gamesById.
 * @param {string} gameId
 * @returns {boolean}
 */
function isPlayable(catalog, gameId) {
  const manifest = catalog.get(gameId);

  return Boolean(manifest) && isGameAvailable(manifest);
}

/**
 * Что делать с маршрутом при загрузке страницы.
 * @param {Object} route - Результат parseRoute.
 * @param {Object|null} roomInfo - Ответ GET /rooms/:roomId (null — комнаты
 *   нет или запрос не удался); для маршрута `game` не используется.
 * @param {Map<string, Object>} catalog - Каталог манифестов вкладки.
 * @returns {{action: 'lobby', informer?: string}
 *   | {action: 'join', gameId: string, roomId: string}
 *   | {action: 'wait', gameId: string, roomId: string}
 *   | {action: 'quickPlay', gameId: string}}
 */
export function decideRouteAction(route, roomInfo, catalog) {
  if (route.kind === 'none') {
    return { action: 'lobby' };
  }

  // комната другой игры, чем в ссылке: верим комнате (ссылку могли
  // отредактировать руками)
  const gameId =
    route.kind === 'room' && roomInfo?.gameId ? roomInfo.gameId : route.gameId;

  if (!isPlayable(catalog, gameId)) {
    return {
      action: 'lobby',
      informer: `Game "${gameId}" is not available.`,
    };
  }

  // комната меняет хоста (host-migration этап 7): она жива, просто войти
  // в неё сейчас не к кому — ждать, пока снова станет online
  if (route.kind === 'room' && roomInfo && isMigrating(roomInfo)) {
    return { action: 'wait', gameId, roomId: route.roomId };
  }

  // мёртвая или полная комната — быстрая игра той же игры (полные она
  // отбрасывает сама)
  if (
    route.kind === 'game' ||
    !roomInfo ||
    roomInfo.currentPlayers >= roomInfo.maxPlayers
  ) {
    return { action: 'quickPlay', gameId };
  }

  return { action: 'join', gameId, roomId: route.roomId };
}

/**
 * Комната по ссылке в смене хоста (поле status ответа GET /rooms/:roomId;
 * мастер до этапа 7 его не отдавал — такая комната считается online).
 * handing_off — плановая передача (этап 8): офферы мастер отклоняет так же.
 * @param {Object} roomInfo
 * @returns {boolean}
 */
export function isMigrating(roomInfo) {
  return roomInfo?.status === 'migrating' || roomInfo?.status === 'handing_off';
}

/**
 * Итог одного опроса комнаты, которая меняет хоста.
 * @param {Object} poll
 * @param {number|null} poll.status - HTTP-статус GET /rooms/:roomId (null —
 *   запрос не дошёл).
 * @param {Object|null} [poll.info] - Тело ответа.
 * @returns {'online'|'gone'|'retry'} gone — только 404: сбой сети или 5xx
 *   посреди миграции не повод уводить игрока из живой комнаты.
 */
export function classifyRoomPoll({ status, info = null }) {
  if (status === 404) {
    return 'gone';
  }

  if (status >= 200 && status < 300 && info && !isMigrating(info)) {
    return 'online';
  }

  return 'retry';
}

/**
 * Пауза быстрой игры перед созданием своей комнаты: гости закрытой комнаты
 * приходят разом, случайный разброс даёт первому создать комнату, а
 * остальным — найти её повторным GET /servers.
 * @param {Object} range - { createDelayMinMs, createDelayMaxMs }.
 * @param {Function} [random] - Math.random (тесты).
 * @returns {number} мс.
 */
export function quickPlayCreateDelay(
  { createDelayMinMs = 0, createDelayMaxMs = 0 } = {},
  random = Math.random,
) {
  const min = Math.max(0, createDelayMinMs);
  const max = Math.max(min, createDelayMaxMs);

  return Math.round(min + (max - min) * random());
}

/**
 * Оптимальная комната быстрой игры: строго этой игры, не полная, с
 * максимумом игроков (при равенстве — первая в списке мастера).
 * @param {Array<Object>} servers - servers из GET /servers.
 * @param {string} gameId
 * @returns {Object|null}
 */
export function pickQuickPlayRoom(servers, gameId) {
  let best = null;

  for (const server of servers ?? []) {
    if (
      server.gameId === gameId &&
      server.currentPlayers < server.maxPlayers &&
      (!best || server.currentPlayers > best.currentPlayers)
    ) {
      best = server;
    }
  }

  return best;
}

/**
 * Куда уходить после разрыва с комнатой (лобби-режим).
 * @param {Object} reason
 * @param {boolean} reason.kicked - Кик хоста (policyClose.isKickClose).
 * @param {string} [reason.gameId] - Игра комнаты.
 * @returns {{route: string} | {reload: string}} route — сменить адрес без
 *   перезагрузки (причина остаётся в #tech-informer); reload — перезагрузка
 *   на маршрут.
 */
export function decideExitRoute({ kicked, gameId }) {
  // кикнутого — на главную: быстрая игра вернула бы его в ту же комнату
  if (kicked) {
    return { route: '' };
  }

  // комната закрылась — в быструю игру той же игры
  return { reload: gameId ? formatGameLink(gameId) : '' };
}
