// Настройки комнаты для холодного перезапуска (host-migration этап 7.6):
// то, что форма создания комнаты передаёт в connectAsHost и что читает
// lib/applyRoomOverrides.js. Хост шлёт их в register_host/reclaim_host,
// мастер хранит санированными и отдаёт преемнику в promote {mode: 'cold'}.
// Модуль изоморфный: им пользуются и клиент (выборка из room), и мастер
// (санитизация недоверенного сообщения)

// потолок сериализованных настроек на мастере
export const ROOM_SETTINGS_MAX_BYTES = 4096;

const MAX_MAP_NAME = 64;
const MAX_PLAYERS = 64;
// таймеры раунда/карты (мс): applyRoomOverrides клампит их ещё раз по
// рамкам игры, здесь — только санитарная граница
const MAX_TIME_MS = 24 * 60 * 60 * 1000;

const toInt = (value, min, max) =>
  Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : undefined;

/**
 * Известные ключи настроек комнаты из недоверенного объекта: числа
 * клампятся, строки обрезаются, остальное отбрасывается.
 * @param {*} source
 * @returns {{ maxPlayers?: number, map?: string, roundTime?: number,
 *   mapTime?: number, friendlyFire?: boolean }}
 */
export function sanitizeRoomSettings(source) {
  if (!source || typeof source !== 'object') {
    return {};
  }

  const settings = {
    maxPlayers: toInt(source.maxPlayers, 1, MAX_PLAYERS),
    map:
      typeof source.map === 'string' && source.map !== ''
        ? source.map.slice(0, MAX_MAP_NAME)
        : undefined,
    roundTime: toInt(source.roundTime, 0, MAX_TIME_MS),
    mapTime: toInt(source.mapTime, 0, MAX_TIME_MS),
    friendlyFire:
      typeof source.friendlyFire === 'boolean'
        ? source.friendlyFire
        : undefined,
  };

  for (const key of Object.keys(settings)) {
    if (settings[key] === undefined) {
      delete settings[key];
    }
  }

  // известных ключей мало и все короткие — потолок держит формат, если
  // список когда-нибудь пополнится
  return JSON.stringify(settings).length > ROOM_SETTINGS_MAX_BYTES
    ? {}
    : settings;
}
