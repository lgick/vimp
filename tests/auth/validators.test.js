import {
  isValidNick,
  isValidRankDelta,
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

describe('isValidRankDelta', () => {
  it('принимает целые числа, положительные и отрицательные, в пределах maxDelta', () => {
    expect(isValidRankDelta(5, 1000)).toBe(true);
    expect(isValidRankDelta(-5, 1000)).toBe(true);
    expect(isValidRankDelta(0, 1000)).toBe(true);
  });

  it('отклоняет нецелые и не-числа', () => {
    expect(isValidRankDelta(1.5, 1000)).toBe(false);
    expect(isValidRankDelta(NaN, 1000)).toBe(false);
    expect(isValidRankDelta(Infinity, 1000)).toBe(false);
  });

  // кодревью №5 (plan/server-rating/review.md): без потолка на модуль дельты
  // один PUT мог разогнать rank до клампа за один матч
  it('отклоняет дельту за пределами maxDelta', () => {
    expect(isValidRankDelta(1001, 1000)).toBe(false);
    expect(isValidRankDelta(-1001, 1000)).toBe(false);
    expect(isValidRankDelta(1000, 1000)).toBe(true);
    expect(isValidRankDelta(-1000, 1000)).toBe(true);
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
