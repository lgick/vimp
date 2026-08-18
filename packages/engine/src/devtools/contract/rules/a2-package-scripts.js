import { ERROR, skip, verdict } from '../result.js';

// Набор npm-скриптов пакета игры (docs/ai/02-packaging.md). Это не вкусовое
// требование: инструкции движка и CI сгенерированной игры зовут их по имени,
// а отсутствующий core:build:node тихо оставляет headless-прогон без ядра.
const REQUIRED = [
  'build',
  'build:client',
  'build:host',
  'build:assets',
  'build:manifest',
  'core:build:web',
  'core:build:node',
  'core:test',
  'test',
];

export default {
  id: 'A2',
  name: 'packageScripts',
  level: ERROR,
  title: 'package.json declares the standard build/test scripts',

  check(ctx) {
    if (!ctx.pkg) {
      return skip('no package.json');
    }

    const scripts = ctx.pkg.scripts ?? {};
    const missing = REQUIRED.filter(name => !scripts[name]);

    return verdict(
      missing.map(name => `script "${name}" is missing`),
    );
  },
};
