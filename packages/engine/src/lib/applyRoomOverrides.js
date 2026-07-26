// Собирает конфиг игры (движковые дефолты + игровая половина) и применяет
// пользовательские настройки комнаты. Используется host.worker.js; вынесено
// в lib для тестируемости (worker вешает self.onmessage при импорте)
import hostDefaults from '../config/hostDefaults.js';

export function applyRoomOverrides(room = {}, plugin) {
  const game = structuredClone({ ...hostDefaults, ...plugin.gameConfig });

  // Этап 5.1: актуальные карты мастера (фетчит главный поток) вместо бандла
  if (room.maps && Object.keys(room.maps).length) {
    game.maps = room.maps;

    // дефолтная карта бандла могла уйти из каталога мастера
    if (!game.maps[game.currentMap]) {
      game.currentMap = Object.keys(game.maps)[0];
    }
  }

  if (Number.isFinite(room.maxPlayers)) {
    game.maxPlayers = Math.max(
      1,
      Math.min(game.roomDefaults.maxPlayers, room.maxPlayers),
    );
  }

  if (room.map && game.maps[room.map]) {
    game.currentMap = room.map;
  }

  // форма лобби — не серверная граница: клампим здесь
  const { roomTimeMin, roomTimeMax } = game.timers;
  const clampTime = ms =>
    Math.min(roomTimeMax, Math.max(roomTimeMin, Math.floor(ms)));

  if (Number.isFinite(room.roundTime)) {
    game.timers.roundTime = clampTime(room.roundTime);
  }

  if (Number.isFinite(room.mapTime)) {
    game.timers.mapTime = clampTime(room.mapTime);
  }

  if (typeof room.friendlyFire === 'boolean') {
    game.parts.friendlyFire = room.friendlyFire;
  }

  return game;
}
