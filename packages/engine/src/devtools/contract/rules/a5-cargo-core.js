import { ERROR, skip, verdict } from '../result.js';

// core/Cargo.toml. Три пункта, каждый — молчаливый отказ:
// crate-type без cdylib не даёт .wasm, rapier2d без enhanced-determinism
// разъезжается между хостом и предиктором на разных машинах, а устаревший
// пин vimp-engine-core собирает игру с чужим ABI (болезнь vimp-street-fighters:
// пин 0.1.0 при крейте движка 0.3.2).
export default {
  id: 'A5',
  name: 'cargoCore',
  level: ERROR,
  title: 'core/Cargo.toml: crate-type, rapier2d determinism, engine pin',

  check(ctx) {
    if (!ctx.cargoText) {
      return skip('no core/Cargo.toml');
    }

    const violations = [];
    // именно в [lib]: тот же ключ встречается в комментариях и в чужих
    // секциях, и поиск по всему файлу выдал бы за проверку случайную строку
    const crateType = readSection(ctx.cargoText, 'lib')?.match(
      /^\s*crate-type\s*=\s*\[([^\]]*)\]/m,
    )?.[1];

    if (!crateType) {
      violations.push('[lib] crate-type is missing (need ["cdylib", "rlib"])');
    } else {
      for (const kind of ['cdylib', 'rlib']) {
        if (!crateType.includes(kind)) {
          violations.push(`[lib] crate-type does not list "${kind}"`);
        }
      }
    }

    const rapier = resolveDep(ctx, 'rapier2d');

    if (!rapier.declared) {
      violations.push('rapier2d is not a dependency');
    } else if (rapier.text && !rapier.text.includes('enhanced-determinism')) {
      violations.push(
        'rapier2d is missing the "enhanced-determinism" feature — physics ' +
          'diverges between machines',
      );
    }

    violations.push(...checkEnginePin(ctx));

    return verdict(violations);
  },
};

// зависимость крейта: `{ workspace = true }` уводит за реальным
// объявлением в корневой Cargo.toml — там же живут и версия, и фичи.
// Недостижимый корень — не нарушение, а отсутствие входа: возвращаем
// null и объявляем зависимость непроверяемой (declared остаётся true)
function resolveDep(ctx, name) {
  const declaration = readDep(ctx.cargoText, name);

  if (!declaration) {
    return { declared: false, text: null };
  }

  if (/workspace\s*=\s*true/.test(declaration)) {
    return {
      declared: true,
      text: ctx.workspaceCargoText
        ? readDep(ctx.workspaceCargoText, name)
        : null,
    };
  }

  return { declared: true, text: declaration };
}

function checkEnginePin(ctx) {
  const { declared, text } = resolveDep(ctx, 'vimp-engine-core');

  if (!declared) {
    return ['vimp-engine-core is not a dependency'];
  }

  // отсутствие входа не должно выглядеть зелёной галочкой: остальные
  // пункты A5 проверены, а пин — нет, и это обязано быть в отчёте
  if (!ctx.engineCoreVersion) {
    ctx.notes?.push(
      'A5: the engine crate version is unknown — the vimp-engine-core pin ' +
        'was NOT checked',
    );

    return [];
  }

  if (!text) {
    ctx.notes?.push(
      'A5: the vimp-engine-core declaration was not found in [dependencies] ' +
        '/ [workspace.dependencies] — the pin was NOT checked',
    );

    return [];
  }

  const pinned = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);

  if (!pinned) {
    ctx.notes?.push(
      `A5: vimp-engine-core is declared without a version (${text.trim()}) — ` +
        'the pin was NOT checked',
    );

    return [];
  }

  const engine = ctx.engineCoreVersion.split('.').map(Number);
  const game = [Number(pinned[1]), Number(pinned[2])];
  const order = game[0] - engine[0] || game[1] - engine[1];

  if (order < 0) {
    return [
      `vimp-engine-core is pinned to ${game.join('.')}, older than this ` +
        `engine's crate ${ctx.engineCoreVersion}`,
    ];
  }

  if (order > 0) {
    return [
      `vimp-engine-core is pinned to ${game.join('.')}, ahead of this ` +
        `engine's crate ${ctx.engineCoreVersion}`,
    ];
  }

  return [];
}

// секции, в которых объявление зависимости считается объявлением. Поиск
// по всему файлу ловил бы `[patch.crates-io] vimp-engine-core = { path =
// … }` — оно есть в игре, созданной с --core-path, версии в нём нет, и
// проверка пина молча проходила бы
const DEP_SECTIONS = new Set([
  'dependencies',
  'workspace.dependencies',
  'build-dependencies',
]);

// объявление зависимости в обеих формах: inline (`dep = { … }` или
// `dep = "x.y"`) и секцией (`[dependencies.dep]` … до следующей секции)
function readDep(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, 'm');

  for (const [header, body] of sections(text)) {
    if (DEP_SECTIONS.has(header)) {
      const found = body.match(inline)?.[1];

      if (found) {
        return found;
      }
    }

    if ([...DEP_SECTIONS].some(dep => header === `${dep}.${name}`)) {
      return body;
    }
  }

  return null;
}

/**
 * Секции TOML: заголовок без скобок и тело до следующего заголовка.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
function sections(text) {
  const header = /^[ \t]*\[([^[\]\n]+)\][ \t]*$/gm;
  const found = [];
  let match = header.exec(text);

  while (match !== null) {
    const start = match.index + match[0].length;
    const next = header.exec(text);

    found.push([
      match[1].trim(),
      text.slice(start, next === null ? text.length : next.index),
    ]);
    match = next;
  }

  return found;
}

function readSection(text, name) {
  return sections(text).find(([header]) => header === name)?.[1] ?? null;
}
