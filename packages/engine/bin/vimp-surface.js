#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSurface,
  formatSurface,
  diffSurface,
} from '../src/devtools/surface/collect.js';

// CLI слепка плагинной поверхности (этап 1 плана plugin-forward-compat):
// без флага печатает расхождение с закоммиченным contract/surface.json и
// возвращает 1 при нарушении И1/И3, с --write перезаписывает слепок.
// Внутренний инструмент репозитория движка: в поле `bin` публикуемого
// пакета он не значится.

const SURFACE_PATH = fileURLToPath(
  new URL('../contract/surface.json', import.meta.url),
);

const USAGE = `Usage: vimp-surface [options]

  --write   rewrite contract/surface.json with the collected surface
  --help
`;

async function main(argv) {
  if (argv.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const surface = await collectSurface();

  if (argv.includes('--write')) {
    await mkdir(path.dirname(SURFACE_PATH), { recursive: true });
    await writeFile(SURFACE_PATH, formatSurface(surface));
    process.stdout.write(`surface: written ${SURFACE_PATH}\n`);

    return 0;
  }

  let committed;

  try {
    committed = JSON.parse(await readFile(SURFACE_PATH, 'utf8'));
  } catch {
    process.stderr.write(
      `surface: no snapshot at ${SURFACE_PATH} — run ` +
        '`npm run surface:update` to create it\n',
    );

    return 1;
  }

  const { violations, additions } = diffSurface(committed, surface);

  for (const addition of additions) {
    process.stdout.write(`surface: добавлено ${addition}\n`);
  }

  if (additions.length > 0 && violations.length === 0) {
    process.stdout.write(
      'слепок устарел, запусти `npm run surface:update` (добавление ' +
        'поверхности совместимость не ломает)\n',
    );
  }

  for (const violation of violations) {
    process.stderr.write(`${violation}\n\n`);
  }

  if (violations.length === 0 && additions.length === 0) {
    process.stdout.write('surface: слепок совпадает\n');
  }

  return violations.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  err => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  },
);
