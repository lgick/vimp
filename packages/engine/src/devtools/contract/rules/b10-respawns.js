import { ERROR, skip, verdict } from '../result.js';

// respawns[team].length — жёсткая вместимость команды на карте
// (RoundManager отказывает в переходе, когда точек не хватает). Комната,
// заявившая maxPlayers больше суммы точек, впускает лишних участников
// наблюдателями и молча меньше, чем обещала.
export default {
  id: 'B10',
  name: 'respawns',
  level: ERROR,
  title: 'every playing team has respawns and they cover maxPlayers',

  check(ctx) {
    const maps = ctx.gameConfig?.maps;
    const teams = ctx.gameConfig?.teams;

    if (!maps || !teams) {
      return skip('no gameConfig.maps or gameConfig.teams');
    }

    const playing = Object.keys(teams).filter(
      team => team !== ctx.gameConfig.spectatorTeam,
    );
    const maxPlayers = ctx.gameConfig.roomDefaults?.maxPlayers;
    const violations = [];

    for (const [name, map] of Object.entries(maps)) {
      const respawns = map?.respawns ?? {};
      let capacity = 0;

      for (const team of playing) {
        const points = respawns[team];

        if (!Array.isArray(points) || !points.length) {
          violations.push(`map "${name}": team "${team}" has no respawns`);
          continue;
        }

        capacity += points.length;
      }

      if (maxPlayers !== undefined && capacity < maxPlayers) {
        violations.push(
          `map "${name}": ${capacity} respawn point(s) for ${maxPlayers} ` +
            'players — the room is silently capped below roomDefaults.maxPlayers',
        );
      }
    }

    return verdict(violations);
  },
};
