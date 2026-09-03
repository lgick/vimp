import { describe, it, expect } from 'vitest';
import { rules } from '../../../packages/engine/src/devtools/contract/rules/index.js';
import {
  FAIL,
  PASS,
  SKIP,
} from '../../../packages/engine/src/devtools/contract/result.js';

// По кейсу на каждую проверку правила E4: правило, которое не умеет
// краснеть, бесполезно ровно так же, как отсутствующее.

const rule = rules.find(item => item.id === 'E4');
const check = maps => rule.check({ gameConfig: { maps } });
const violations = maps => check(maps).violations.join('\n');

// заведомо корректная слоёная карта 2x2 с одной рампой
const goodMap = () => ({
  step: 32,
  spriteSheet: { img: 't.png', frames: [[0, 0, 32, 32], [32, 0, 32, 32]] },
  map: [
    [0, 1],
    [2, 3],
  ],
  physicsStatic: [1],
  physicsDynamic: [{ level: 1 }],
  respawns: { players: [[10, 20, 0], [30, 40, 0, 1]] },
  levels: {
    1: {
      map: [
        [0, 4],
        [5, 6],
      ],
      floor: [4, 5, 6],
      walls: [6],
      layers: { 2: [0, 1] },
    },
  },
  ramps: [{ tile: 2, dir: 'east', from: 0, to: 1 }],
});

const broken = mutate => {
  const map = goodMap();

  mutate(map);

  return { m1: map };
};

describe('E4 mapLayers', () => {
  it('пропускается, когда слоёных карт нет', () => {
    expect(check({ m1: { map: [[0]] } }).status).toBe(SKIP);
    expect(check(undefined).status).toBe(SKIP);
  });

  it('корректная слоёная карта проходит', () => {
    expect(check({ m1: goodMap() }).status).toBe(PASS);
  });

  it('1. ключ уровня — не номер или не с единицы подряд', () => {
    expect(violations(broken(m => {
      m.levels = { 2: m.levels[1] };
    }))).toMatch(/levels must run from 1 without gaps/);

    expect(violations(broken(m => {
      m.levels = { top: m.levels[1] };
    }))).toMatch(/is not a level number/);
  });

  it('2. размерность грида уровня разошлась с map', () => {
    expect(violations(broken(m => {
      m.levels[1].map = [[0, 4]];
    }))).toMatch(/level 1 grid has 1 rows, map has 2/);

    expect(violations(broken(m => {
      m.levels[1].map = [[0], [5, 6]];
    }))).toMatch(/level 1 row 0 has 1 cells, map has 2/);
  });

  it('3. перила вне плиты', () => {
    expect(violations(broken(m => {
      m.levels[1].walls = [9];
    }))).toMatch(/wall tile 9 is not part of floor/);
  });

  it('4. тайл рампы отсутствует в гриде уровня from', () => {
    expect(violations(broken(m => {
      m.ramps[0].tile = 99;
    }))).toMatch(/ramp 0 tile 99 is missing from level 0 grid/);
  });

  it('5. направление рампы и переход в себя', () => {
    expect(violations(broken(m => {
      m.ramps[0].dir = 'up';
    }))).toMatch(/dir "up" is not one of/);

    expect(violations(broken(m => {
      m.ramps[0].to = 0;
    }))).toMatch(/goes from level 0 to itself/);

    expect(violations(broken(m => {
      m.ramps[0].to = 5;
    }))).toMatch(/references a level out of range/);
  });

  it('6. длина точки респауна и её уровень', () => {
    expect(violations(broken(m => {
      m.respawns.players = [[10, 20]];
    }))).toMatch(/has 2 numbers, expected 3 or 4/);

    expect(violations(broken(m => {
      m.respawns.players = [[10, 20, 0, 3]];
    }))).toMatch(/level 3 is out of range/);
  });

  it('7. уровень динамического тела вне диапазона', () => {
    expect(violations(broken(m => {
      m.physicsDynamic = [{ level: 2 }];
    }))).toMatch(/physicsDynamic 0 level 2 is out of range/);
  });

  it('8. тайл рендер-слоя уровня отсутствует в тайл-листе', () => {
    expect(violations(broken(m => {
      m.levels[1].layers = { 2: [7] };
    }))).toMatch(/layer 2 names tile 7/);
  });

  it('нарушения складываются, а не обрывают проверку на первом', () => {
    const result = check(broken(m => {
      m.levels[1].walls = [9];
      m.ramps[0].tile = 99;
    }));

    expect(result.status).toBe(FAIL);
    expect(result.violations.length).toBe(2);
  });
});
