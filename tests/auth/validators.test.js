import {
  isValidNick,
  isValidGameResult,
  isValidStateSize,
  isValidVoteValue,
  isValidVoteReason,
  clampLimit,
} from '../../packages/auth/src/lib/validators.js';

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
