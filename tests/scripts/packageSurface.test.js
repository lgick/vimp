import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

// Публикуемая поверхность пакета vimp-engine (Этап 3 плана standalone-sdk).
// С выходом standalone SDK в npm уезжает и клиентская половина движка —
// а у неё есть внешние зависимости (howler, pixi.js). История с howler в
// devDependencies (публикуемый src/client/SoundManager.js импортировал пакет,
// которого у потребителя не было) не воспроизводима вручную: локально она не
// видна вовсе, ломается только чужая установка. Отсюда этот тест.

const ROOT = path.resolve(import.meta.dirname, '../..');
const PKG_DIR = path.join(ROOT, 'packages/engine');

// каталоги, код которых уезжает в npm и потому обязан быть самодостаточным
const PUBLIC_SOURCE_DIRS = ['src/client', 'src/standalone'];

let pkg;

beforeAll(async () => {
  pkg = JSON.parse(await readFile(path.join(PKG_DIR, 'package.json'), 'utf8'));
});

describe('публикуемая поверхность vimp-engine', () => {
  it('каждая цель exports существует на диске', () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      // wildcard-цель проверяется по своему каталогу
      const relative = target.replace(/\/\*$/, '');

      expect(
        existsSync(path.join(PKG_DIR, relative)),
        `exports["${subpath}"] → ${target}`,
      ).toBe(true);
    }
  });

  it('каждый путь files существует на диске', () => {
    for (const entry of pkg.files) {
      // отрицания (`!src/client/_*` — scratch-файлы) каталогами не являются
      if (entry.startsWith('!')) {
        continue;
      }

      expect(existsSync(path.join(PKG_DIR, entry)), `files: ${entry}`).toBe(
        true,
      );
    }
  });

  it('публикуемый клиентский код не выходит за пределы files', async () => {
    const roots = pkg.files
      .filter(entry => !entry.startsWith('!'))
      .map(entry => path.join(PKG_DIR, entry));
    const outside = [];

    for (const dir of PUBLIC_SOURCE_DIRS) {
      for await (const file of walk(path.join(PKG_DIR, dir))) {
        for (const spec of importsOf(await readFile(file, 'utf8'))) {
          if (!spec.startsWith('.')) {
            continue;
          }

          const target = path.resolve(path.dirname(file), spec);

          const inside = roots.some(
            root =>
              target === root || target.startsWith(`${root}${path.sep}`),
          );

          if (!inside) {
            outside.push(`${path.relative(PKG_DIR, file)} → ${spec}`);
          }
        }
      }
    }

    expect(outside).toEqual([]);
  });

  it('все внешние пакеты публикуемого клиента объявлены в dependencies', async () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const missing = new Set();

    for (const dir of PUBLIC_SOURCE_DIRS) {
      for await (const file of walk(path.join(PKG_DIR, dir))) {
        for (const spec of importsOf(await readFile(file, 'utf8'))) {
          if (spec.startsWith('.') || isBuiltin(spec)) {
            continue;
          }

          const name = packageName(spec);

          if (!declared.has(name)) {
            missing.add(`${path.relative(PKG_DIR, file)} → ${name}`);
          }
        }
      }
    }

    expect([...missing]).toEqual([]);
  });
});

// все статические и динамические импорты модуля по литеральному специфайеру
// (динамика по переменной — загрузка плагина игры, к пакету отношения не имеет)
function importsOf(source) {
  const specs = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /import\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specs.push(match[1]);
    }
  }

  return specs;
}

// 'pixi.js/unsafe-eval' → 'pixi.js', '@scope/pkg/sub' → '@scope/pkg'
function packageName(spec) {
  const parts = spec.split('/');

  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    // `_`-файлы и каталоги в публикацию не уезжают (конвенция репозитория)
    if (entry.name.startsWith('_')) {
      continue;
    }

    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.js')) {
      yield full;
    }
  }
}
