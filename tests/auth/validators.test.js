import {
  isValidNick,
  isValidRankDelta,
  isValidStateSize,
  isValidVoteValue,
  isValidVoteReason,
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
  it('принимает целые числа, положительные и отрицательные', () => {
    expect(isValidRankDelta(5)).toBe(true);
    expect(isValidRankDelta(-5)).toBe(true);
    expect(isValidRankDelta(0)).toBe(true);
  });

  it('отклоняет нецелые и не-числа', () => {
    expect(isValidRankDelta(1.5)).toBe(false);
    expect(isValidRankDelta(NaN)).toBe(false);
    expect(isValidRankDelta(Infinity)).toBe(false);
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
