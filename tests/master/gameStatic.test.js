import { describe, it, expect } from 'vitest';
import { parseGamePath } from '../../packages/engine/src/master/gameStatic.js';

// Разбор пути игровой статики: общий для раздачи /games и расшифровки стеков
// журнала клиентских ошибок (plan/client-reports, этап 4)

describe('parseGamePath', () => {
  it('с версией: остаток — после версии', () => {
    expect(parseGamePath('/tanks/1.2.3/assets/client-abc.js')).toEqual({
      id: 'tanks',
      version: '1.2.3',
      rest: 'assets/client-abc.js',
    });
  });

  it('без версии: остаток начинается со второго сегмента', () => {
    expect(parseGamePath('/tanks/assets/client-abc.js')).toEqual({
      id: 'tanks',
      version: undefined,
      rest: 'assets/client-abc.js',
    });
  });

  it('декодирует id и версию', () => {
    expect(parseGamePath('/tan%6Bs/1.0.0-beta.1/x.js')).toEqual({
      id: 'tanks',
      version: '1.0.0-beta.1',
      rest: 'x.js',
    });
  });

  it('битая процентная последовательность → null', () => {
    expect(parseGamePath('/%ZZ/x.js')).toBeNull();
    expect(parseGamePath('/tanks/%ZZ/x.js')).toBeNull();
  });
});
