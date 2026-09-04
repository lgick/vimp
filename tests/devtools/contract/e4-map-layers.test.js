import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { rules } from '../../../packages/engine/src/devtools/contract/rules/index.js';
import {
  FAIL,
  PASS,
  SKIP,
} from '../../../packages/engine/src/devtools/contract/result.js';

// Правило, которое не умеет краснеть, бесполезно ровно так же, как
// отсутствующее. Корпус кейсов общий с ядром: те же карты гоняет
// `map::tests::shared_layered_fixtures` (Rust), и обе стороны обязаны
// сказать про одно и то же нарушение одно и то же по сути — иначе первый
// разошедшийся случай будет молчаливым.
const FIXTURES = path.resolve(
  import.meta.dirname,
  '../../../packages/engine/contract/fixtures/layered',
);

const fixture = name =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

const cases = readdirSync(FIXTURES)
  .filter(file => file.endsWith('.json'))
  .map(file => file.replace(/\.json$/, ''));

const rule = rules.find(item => item.id === 'E4');
const check = maps => rule.check({ gameConfig: { maps } });
const violations = maps => check(maps).violations.join('\n');

const goodMap = () => fixture('good').map;

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

  it('корпус фикстур прочитан', () => {
    expect(cases.length).toBeGreaterThan(1);
    expect(cases).toContain('good');
  });

  it.each(cases)('фикстура %s', name => {
    const { map, expect: fragment } = fixture(name);
    const result = check({ m1: map });

    if (fragment === undefined) {
      expect(result.status, result.violations.join('\n')).toBe(PASS);
      return;
    }

    expect(result.status).toBe(FAIL);
    expect(result.violations.join('\n')).toContain(fragment);
  });

  // кейсы, которых в корпусе нет: ядро о них не знает (рендер-слои и
  // строковое направление рампы — поля клиента, serde ловит их сам)
  it('направление рампы — не одно из четырёх', () => {
    expect(violations(broken(m => {
      m.ramps[0].dir = 'up';
    }))).toMatch(/dir "up" is not one of/);
  });

  it('тайл рендер-слоя уровня отсутствует в тайл-листе', () => {
    expect(violations(broken(m => {
      m.levels[1].layers = { 2: [99] };
    }))).toMatch(/layer 2 names tile 99/);
  });

  it('открытый край над плитой нижнего уровня — законный обрыв', () => {
    // до `landing_level` край требовал проходимой ЗЕМЛИ: плита этажом ниже
    // ошибкой не является, с неё просто падают на неё же
    const row = (a, b, c, d, e) => [a, b, c, d, e];
    const ground = Array.from({ length: 5 }, () => row(0, 0, 0, 0, 0));

    // уровень 1 — плита 5x5, край закрыт перилами (тайл 1)
    const slab = [
      row(1, 1, 1, 1, 1),
      row(1, 0, 0, 0, 1),
      row(1, 0, 0, 0, 1),
      row(1, 0, 0, 0, 1),
      row(1, 1, 1, 1, 1),
    ];

    // уровень 2 — одинокая клетка без перил: все четыре её стороны открыты,
    // и под ними плита уровня 1
    const island = [
      row(2, 2, 2, 2, 2),
      row(2, 2, 2, 2, 2),
      row(2, 2, 0, 2, 2),
      row(2, 2, 2, 2, 2),
      row(2, 2, 2, 2, 2),
    ];

    const map = {
      map: ground,
      physicsStatic: [],
      layers: { 1: [0] },
      levels: {
        1: { map: slab, floor: [0, 1], walls: [1], layers: { 2: [0, 1] } },
        2: { map: island, floor: [0], walls: [], layers: { 3: [0] } },
      },
    };

    expect(check({ m1: map }).status).toBe(PASS);
  });

  it('нарушения складываются, а не обрываются на первом', () => {
    const result = check(broken(m => {
      m.levels[1].walls = [8, 5];
      m.ramps[0].tile = 99;
    }));

    expect(result.status).toBe(FAIL);
    expect(result.violations.length).toBe(2);
  });
});
