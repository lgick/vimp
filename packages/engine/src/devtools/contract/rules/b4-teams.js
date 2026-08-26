import { ERROR, skip, verdict } from '../result.js';

// teams/spectatorTeam. Опечатка в spectatorTeam ловится гейтом B3; здесь —
// вторая половина контракта: играющая команда должна быть хотя бы одна,
// иначе раунд некому начинать, а все участники висят наблюдателями.
// Под noSpectators наблюдателей нет вовсе: команда обязана быть ровно одна.
export default {
  id: 'B4',
  name: 'teams',
  level: ERROR,
  title: 'spectatorTeam is a teams key and at least one playing team exists',

  check(ctx) {
    const teams = ctx.gameConfig?.teams;

    if (!teams) {
      return skip('no gameConfig.teams');
    }

    const { spectatorTeam } = ctx.gameConfig;
    const violations = [];

    if (ctx.gameConfig.noSpectators === true) {
      const names = Object.keys(teams);

      if (names.length !== 1) {
        violations.push(
          `noSpectators requires exactly one team, got ${names.length} ` +
            `(${names.join(', ')})`,
        );
      }

      return verdict(violations);
    }

    if (teams[spectatorTeam] === undefined) {
      violations.push(
        `spectatorTeam "${spectatorTeam}" is not a key of teams ` +
          `(${Object.keys(teams).join(', ')})`,
      );
    }

    const playing = Object.keys(teams).filter(team => team !== spectatorTeam);

    if (!playing.length) {
      violations.push('teams declares no playing team besides the spectators');
    }

    return verdict(violations);
  },
};
