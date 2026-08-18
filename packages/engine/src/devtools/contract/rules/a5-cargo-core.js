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
    const crateType = ctx.cargoText.match(/crate-type\s*=\s*\[([^\]]*)\]/)?.[1];

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

  if (!text || !ctx.engineCoreVersion) {
    return [];
  }

  const pinned = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);

  if (!pinned) {
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

// объявление зависимости в обеих формах: inline (`dep = { … }` или
// `dep = "x.y"`) и секцией (`[dependencies.dep]` … до следующей секции)
function readDep(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = text.match(
    new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, 'm'),
  )?.[1];

  if (inline) {
    return inline;
  }

  const section = text.split(/^\s*\[/m).find(part =>
    part.startsWith(`dependencies.${name}]`),
  );

  return section ?? null;
}
