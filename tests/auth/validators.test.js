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
} from '../../packages/auth/src/lib/validators.js';
import config from '../../packages/auth/src/config/auth.js';

describe('validators (auth)', () => {
  it('принимает корректный ник', () => {
    expect(isValidNick('Player1')).toBe(true);
    expect(isValidNick('a')).toBe(false); // короче двух символов не пропускает regexp
    expect(isValidNick('Ab')).toBe(true);
  });

  it('отклоняет ник с недопустимыми символами или неверным началом', () => {
    expect(isValidNick('1Player')).toBe(false); // не начинается с буквы
    expect(isValidNick('Pla!yer')).toBe(false); // недопустимый символ
    expect(isValidNick('')).toBe(false);
  });

  it('отклоняет управляющие пробельные символы внутри ника (F13)', () => {
    expect(isValidNick('Pla\tyer')).toBe(false);
    expect(isValidNick('Pla\nyer')).toBe(false);
    expect(isValidNick('Pla yer')).toBe(true);
  });

  it('отклоняет не-строки', () => {
    expect(isValidNick(undefined)).toBe(false);
    expect(isValidNick(null)).toBe(false);
    expect(isValidNick(123)).toBe(false);
  });
});

describe('isValidStateSize', () => {
  it('пропускает state в пределах лимита', () => {
    expect(isValidStateSize({ skill: 5 }, 8192)).toBe(true);
  });

  it('отклоняет state, превышающий лимит байт', () => {
    expect(isValidStateSize({ blob: 'x'.repeat(20) }, 10)).toBe(false);
  });
});

describe('isValidVoteValue', () => {
  it('принимает только +1 и -1', () => {
    expect(isValidVoteValue(1)).toBe(true);
    expect(isValidVoteValue(-1)).toBe(true);
  });

  it('отклоняет любые другие значения', () => {
    expect(isValidVoteValue(0)).toBe(false);
    expect(isValidVoteValue(2)).toBe(false);
    expect(isValidVoteValue('1')).toBe(false);
    expect(isValidVoteValue(undefined)).toBe(false);
  });
});

describe('isValidVoteReason', () => {
  it('принимает непустую строку', () => {
    expect(isValidVoteReason('good game')).toBe(true);
  });

  it('отклоняет пустую/пробельную строку и не-строки', () => {
    expect(isValidVoteReason('')).toBe(false);
    expect(isValidVoteReason('   ')).toBe(false);
    expect(isValidVoteReason(undefined)).toBe(false);
    expect(isValidVoteReason(null)).toBe(false);
  });
});

// code review L3: клампинг GET /leaderboard?limit= вынесен из main.js сюда,
// чтобы быть покрытым юнит-тестом независимо от роута
describe('clampLimit', () => {
  it('клампит в диапазон [1, max]', () => {
    expect(clampLimit(50, 10, 100)).toBe(50);
    expect(clampLimit(0, 10, 100)).toBe(1);
    expect(clampLimit(9999, 10, 100)).toBe(100);
  });

  it('невалидное значение (не целое/отсутствует) — fallback', () => {
    expect(clampLimit(undefined, 10, 100)).toBe(10);
    expect(clampLimit('junk', 10, 100)).toBe(10);
    expect(clampLimit(1.5, 10, 100)).toBe(10);
  });
});

// snakes-v3 (stage_2.md, 2.5): PUT /rank принимает результат игры
describe('isValidGameResult', () => {
  const limits = { maxGameScore: 10000, maxPoints: 200000 };

  it('принимает целую пару в пределах, где best не больше points', () => {
    expect(isValidGameResult(1200, 800, limits)).toBe(true);
    expect(isValidGameResult(0, 0, limits)).toBe(true);
    expect(isValidGameResult(10000, 10000, limits)).toBe(true);
  });

  it('отклоняет отрицательные и дробные', () => {
    expect(isValidGameResult(-1, 0, limits)).toBe(false);
    expect(isValidGameResult(10, -1, limits)).toBe(false);
    expect(isValidGameResult(1.5, 1, limits)).toBe(false);
    expect(isValidGameResult(10, 1.5, limits)).toBe(false);
    expect(isValidGameResult(NaN, 0, limits)).toBe(false);
  });

  // best — максимум среди игр, чья сумма равна points; нарушение означает
  // битого клиента, а не безобидное округление
  it('отклоняет best больше points', () => {
    expect(isValidGameResult(100, 101, limits)).toBe(false);
  });

  it('отклоняет выход за пределы одной игры и за предел запроса', () => {
    expect(isValidGameResult(20000, 10001, limits)).toBe(false);
    expect(isValidGameResult(200001, 100, limits)).toBe(false);
    expect(isValidGameResult(200000, 10000, limits)).toBe(true);
  });
});

// поля заявки на игру (master-game-registry, этап 1): id и version
// становятся сегментами URL раздачи /games/<id>/<version>/
describe('validators: реестр игр', () => {
  it('id — строчная латиница, цифры и дефис, начиная с буквы', () => {
    expect(isValidGameId('tanks', config.games)).toBe(true);
    expect(isValidGameId('my-game-2', config.games)).toBe(true);
    expect(isValidGameId('Tanks', config.games)).toBe(false);
    expect(isValidGameId('2fast', config.games)).toBe(false);
    expect(isValidGameId('a', config.games)).toBe(false);
    expect(isValidGameId('../etc', config.games)).toBe(false);
    expect(isValidGameId(undefined, config.games)).toBe(false);
  });

  it('имя пакета принимает scoped и отклоняет мусор', () => {
    expect(isValidPackageName('@vimp-games/tanks', config.games)).toBe(true);
    expect(isValidPackageName('pong', config.games)).toBe(true);
    expect(isValidPackageName('@scope/../evil', config.games)).toBe(false);
    expect(isValidPackageName('Tanks', config.games)).toBe(false);
  });

  it('версия — строгий semver-триплет, без диапазонов и тегов', () => {
    expect(isValidGameVersion('0.16.1', config.games)).toBe(true);
    expect(isValidGameVersion('1.0.0-rc.1', config.games)).toBe(true);
    expect(isValidGameVersion('latest', config.games)).toBe(false);
    expect(isValidGameVersion('^1.0.0', config.games)).toBe(false);
    expect(isValidGameVersion('1.0', config.games)).toBe(false);
  });

  it('title и repoUrl необязательны, но ограничены', () => {
    expect(isValidGameTitle(undefined, config.games)).toBe(true);
    expect(isValidGameTitle(null, config.games)).toBe(true);
    expect(isValidGameTitle('VIMP Tanks', config.games)).toBe(true);
    expect(isValidGameTitle('   ', config.games)).toBe(false);
    expect(isValidGameTitle('x'.repeat(config.games.maxTitleLength + 1), config.games)).toBe(false);

    expect(isValidRepoUrl(undefined, config.games)).toBe(true);
    expect(isValidRepoUrl('https://github.com/lgick/vimp-tanks', config.games)).toBe(true);
    expect(isValidRepoUrl('javascript:alert(1)', config.games)).toBe(false);
    expect(isValidRepoUrl('not a url', config.games)).toBe(false);
    expect(isValidRepoUrl(`https://e.com/${'x'.repeat(config.games.maxUrlLength)}`, config.games))
      .toBe(false);
  });

  it('замечание модератора ограничено по длине, пустое — снятие', () => {
    expect(isValidModeratorNote(null, config.games)).toBe(true);
    expect(isValidModeratorNote('версия падает на старте', config.games)).toBe(true);
    expect(isValidModeratorNote('x'.repeat(config.games.maxNoteLength + 1), config.games))
      .toBe(false);
  });

  it('зарезервированные id отклоняются: их занимают роуты реестра', () => {
    config.games.reservedIds.forEach(id => {
      expect(isValidGameId(id, config.games)).toBe(false);
    });
  });

  it('missingGameField называет первое отсутствующее обязательное поле', () => {
    expect(missingGameField({})).toBe('id');
    expect(missingGameField({ id: 'pong' })).toBe('packageName');
    expect(missingGameField({ id: 'pong', packageName: '@dev/pong' })).toBe('version');
    expect(missingGameField({ id: 'pong', packageName: '@dev/pong', version: '1.0.0' }))
      .toBeNull();
    // отсутствие ≠ кривое значение: формат проверяет gameInputError
    expect(missingGameField({ id: '', packageName: '', version: '' })).toBeNull();
  });

  it('maxGameScore ограничен потолками самого auth', () => {
    const { rank } = config;

    expect(isValidMaxGameScore(1, rank)).toBe(true);
    expect(isValidMaxGameScore(rank.maxGameScore, rank)).toBe(true);
    expect(isValidMaxGameScore(0, rank)).toBe(false);
    expect(isValidMaxGameScore(-5, rank)).toBe(false);
    expect(isValidMaxGameScore(1.5, rank)).toBe(false);
    expect(isValidMaxGameScore('1000', rank)).toBe(false);
    expect(isValidMaxGameScore(rank.maxGameScore + 1, rank)).toBe(false);
    // произведение на окно склейки движка не должно перерастать maxPoints:
    // иначе хост уходит в вечный повтор отклонённого flush
    expect(isValidMaxGameScore(1000000, rank)).toBe(false);
    expect(isValidMaxGameScore(Math.floor(rank.maxPoints / 20), { ...rank, maxGameScore: 1e9 }))
      .toBe(true);
    expect(
      isValidMaxGameScore(Math.floor(rank.maxPoints / 20) + 1, { ...rank, maxGameScore: 1e9 }),
    ).toBe(false);
  });
});
