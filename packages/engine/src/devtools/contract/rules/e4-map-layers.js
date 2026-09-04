import { ERROR, skip, verdict } from '../result.js';

// Слоёная (2.5D) карта проверяется в ядре (`MapConfig::validate`), но там
// это ошибка загрузки уже запущенного матча. Здесь то же самое ловится до
// сборки и без ядра: рассинхрон размерностей гридов даёт танк,
// проваливающийся в пустоту, и ни одной строки в консоли.
//
// Правило безвредно для одноуровневой игры: без `levels` ни одна проверка
// не срабатывает.
export default {
  id: 'E4',
  name: 'mapLayers',
  level: ERROR,
  title: 'layered maps are structurally sound',

  check(ctx) {
    const maps = ctx.gameConfig?.maps;

    if (!maps) {
      return skip('no gameConfig.maps');
    }

    const layered = Object.entries(maps).filter(
      ([, map]) => map?.levels && Object.keys(map.levels).length > 0,
    );

    if (!layered.length) {
      return skip('no layered maps');
    }

    const violations = [];

    for (const [name, map] of layered) {
      checkMap(name, map, violations);
    }

    return verdict(violations);
  },
};

const RAMP_DIRS = ['north', 'south', 'west', 'east'];

function checkMap(name, map, violations) {
  const at = `map "${name}"`;
  const levels = map.levels ?? {};
  // уровень 0 живёт в map/physicsStatic/layers и в `levels` не значится
  const levelCount = Object.keys(levels).length + 1;

  // 1. ключи — целые >= 1, подряд от 1
  const keys = Object.keys(levels).map(Number);

  for (const key of Object.keys(levels)) {
    if (!/^\d+$/.test(key) || Number(key) < 1) {
      violations.push(
        `${at}: levels key "${key}" is not a level number >= 1 ` +
          '(level 0 lives in map/physicsStatic)',
      );
    }
  }

  const sorted = [...keys].sort((a, b) => a - b);

  sorted.forEach((level, index) => {
    if (level !== index + 1) {
      violations.push(
        `${at}: levels must run from 1 without gaps, got ${level} at ` +
          `position ${index + 1}`,
      );
    }
  });

  const grid = map.map ?? [];

  for (const [key, level] of Object.entries(levels)) {
    // 2. размерность грида уровня совпадает с гридом уровня 0
    const levelGrid = level?.map ?? [];

    if (levelGrid.length !== grid.length) {
      violations.push(
        `${at}: level ${key} grid has ${levelGrid.length} rows, ` +
          `map has ${grid.length}`,
      );
    }

    levelGrid.forEach((row, y) => {
      const expected = grid[y]?.length;

      if (expected !== undefined && row.length !== expected) {
        violations.push(
          `${at}: level ${key} row ${y} has ${row.length} cells, ` +
            `map has ${expected}`,
        );
      }
    });

    // 3. перила — часть плиты: тайл вне floor не экранирует луч снизу
    const floor = level?.floor ?? [];

    for (const tile of level?.walls ?? []) {
      if (!floor.includes(tile)) {
        violations.push(
          `${at}: level ${key} wall tile ${tile} is not part of floor`,
        );
      }
    }

    // 8. тайл рендер-слоя обязан существовать в тайл-листе по индексу
    checkLayerFrames(at, `level ${key}`, level?.layers, map.spriteSheet, violations);
  }

  for (const [index, ramp] of (map.ramps ?? []).entries()) {
    const from = ramp?.from ?? 0;
    const to = ramp?.to ?? 1;

    // 5. направление и осмысленность перехода
    if (!RAMP_DIRS.includes(ramp?.dir)) {
      violations.push(
        `${at}: ramp ${index} dir "${ramp?.dir}" is not one of ` +
          RAMP_DIRS.join('|'),
      );
    }

    if (from === to) {
      violations.push(`${at}: ramp ${index} goes from level ${from} to itself`);
    }

    if (from >= levelCount || to >= levelCount) {
      violations.push(
        `${at}: ramp ${index} references a level out of range ` +
          `(levels: ${levelCount})`,
      );
    }

    // 4. тайл рампы обязан встречаться в гриде уровня, с которого она идёт
    const fromGrid = from === 0 ? grid : levels[String(from)]?.map;
    const found = (fromGrid ?? []).some(row => row.includes(ramp?.tile));

    if (!found) {
      violations.push(
        `${at}: ramp ${index} tile ${ramp?.tile} is missing from ` +
          `level ${from} grid`,
      );
      continue;
    }

    // 9. рампа, ведущая в пустоту: за верхним концом прогона обязана быть
    // поверхность уровня `to`. Иначе танк доезжает до вершины и в тот же шаг
    // срывается вниз — молча, потому что и подъём, и падение штатные правила
    for (const [x, y] of rampRunExits(fromGrid ?? [], ramp?.tile, ramp?.dir)) {
      if (!walkable(map, to, x, y)) {
        violations.push(
          `${at}: ramp ${index} run ends at (${x}, ${y}), which is not ` +
            `walkable ground of level ${to}`,
        );
      }
    }
  }

  // 10. край плиты без перил — обрыв; приземлиться с него нужно на
  // проходимую землю, иначе танк уезжает за карту (стены уровня 0 плите не
  // преграда) или приземляется внутри стены
  checkLevelEdges(at, map, violations);

  // 6. точка респауна: [x, y, angle] либо [x, y, angle, level]
  for (const [team, points] of Object.entries(map.respawns ?? {})) {
    for (const [index, point] of (points ?? []).entries()) {
      if (point.length !== 3 && point.length !== 4) {
        violations.push(
          `${at}: respawns ${team}[${index}] has ${point.length} numbers, ` +
            'expected 3 or 4',
        );
        continue;
      }

      if (point.length === 4 && point[3] >= levelCount) {
        violations.push(
          `${at}: respawns ${team}[${index}] level ${point[3]} is out of ` +
            `range (levels: ${levelCount})`,
        );
      }
    }
  }

  // 7. уровень динамического тела
  for (const [index, object] of (map.physicsDynamic ?? []).entries()) {
    const level = object?.level ?? 0;

    if (level >= levelCount) {
      violations.push(
        `${at}: physicsDynamic ${index} level ${level} is out of range ` +
          `(levels: ${levelCount})`,
      );
    }
  }
}

// --- геометрия уровней (зеркало vimp_engine_core::map::validate_levels) ---

function cellAt(grid, x, y) {
  if (x < 0 || y < 0) {
    return undefined;
  }

  return grid?.[y]?.[x];
}

// земля проходима, если клетка есть в гриде и её тайл не объявлен стеной
function groundWalkable(map, x, y) {
  const tile = cellAt(map.map ?? [], x, y);

  return tile !== undefined && !(map.physicsStatic ?? []).includes(tile);
}

function walkable(map, level, x, y) {
  if (level === 0) {
    return groundWalkable(map, x, y);
  }

  const cfg = (map.levels ?? {})[String(level)];

  if (!cfg) {
    return false;
  }

  const tile = cellAt(cfg.map ?? [], x, y);

  return (
    tile !== undefined &&
    (cfg.floor ?? []).includes(tile) &&
    !(cfg.walls ?? []).includes(tile)
  );
}

// клетки, следующие за верхними концами прогонов рампы (прогон —
// непрерывная линия одинаковых тайлов вдоль оси рампы)
function rampRunExits(grid, tile, dir) {
  const sign = dir === 'south' || dir === 'east' ? 1 : -1;
  const vertical = dir === 'north' || dir === 'south';
  const out = [];

  if (vertical) {
    const cols = Math.max(0, ...grid.map(row => row.length));

    for (let x = 0; x < cols; x += 1) {
      let y = 0;

      while (y < grid.length) {
        if (grid[y][x] !== tile) {
          y += 1;
          continue;
        }

        const y0 = y;

        while (y < grid.length && grid[y][x] === tile) {
          y += 1;
        }

        out.push([x, sign > 0 ? y : y0 - 1]);
      }
    }

    return out;
  }

  grid.forEach((row, y) => {
    let x = 0;

    while (x < row.length) {
      if (row[x] !== tile) {
        x += 1;
        continue;
      }

      const x0 = x;

      while (x < row.length && row[x] === tile) {
        x += 1;
      }

      out.push([sign > 0 ? x : x0 - 1, y]);
    }
  });

  return out;
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function checkLevelEdges(at, map, violations) {
  for (const [key, level] of Object.entries(map.levels ?? {})) {
    const floor = level?.floor ?? [];
    const walls = level?.walls ?? [];
    const grid = level?.map ?? [];

    grid.forEach((row, y) => {
      row.forEach((tile, x) => {
        // перила закрывают край сами; клетка вне плиты краем не бывает
        if (!floor.includes(tile) || walls.includes(tile)) {
          return;
        }

        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          const neighbour = cellAt(grid, nx, ny);

          if (neighbour !== undefined && floor.includes(neighbour)) {
            continue;
          }

          if (groundWalkable(map, nx, ny)) {
            continue;
          }

          violations.push(
            `${at}: level ${key} floor cell (${x}, ${y}) has an open edge ` +
              `at (${nx}, ${ny}) with no walkable ground below — close it ` +
              'with a wall tile',
          );
        }
      });
    });
  }
}

function checkLayerFrames(at, where, layers, spriteSheet, violations) {
  const frames = spriteSheet?.frames;

  if (!Array.isArray(frames)) {
    return;
  }

  for (const [layer, tiles] of Object.entries(layers ?? {})) {
    for (const tile of tiles ?? []) {
      if (frames[tile] === undefined) {
        violations.push(
          `${at}: ${where} layer ${layer} names tile ${tile}, ` +
            `spriteSheet.frames has ${frames.length}`,
        );
      }
    }
  }
}
