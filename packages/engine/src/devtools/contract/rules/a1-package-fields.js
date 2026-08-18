import { ERROR, skip, verdict } from '../result.js';

// Поля package.json, от которых зависит не сборка, а поведение в бою:
// вбандленный pixi.js даёт вторую копию PixiJS со своим реестром расширений
// (объекты одной копии падают в другой), а vimp-engine в dependencies тянет
// движок внутрь пакета игры — движок загружает плагин, не наоборот.
export default {
  id: 'A1',
  name: 'packageFields',
  level: ERROR,
  title: 'package.json: type, files, pixi.js, vimp-engine, publishConfig',

  check(ctx) {
    if (!ctx.pkg) {
      return skip('no package.json');
    }

    const {
      name,
      type,
      files,
      publishConfig,
      dependencies = {},
      devDependencies = {},
      peerDependencies = {},
    } = ctx.pkg;
    const violations = [];

    if (type !== 'module') {
      violations.push(`"type" is ${JSON.stringify(type)}, must be "module"`);
    }

    if (!Array.isArray(files) || !files.includes('dist')) {
      violations.push('"files" must list "dist" — only dist/ is published');
    }

    if (dependencies['pixi.js']) {
      violations.push(
        'pixi.js is in dependencies — it must be external (peer + dev), ' +
          'otherwise the bundle ships a second PixiJS instance',
      );
    }

    if (!peerDependencies['pixi.js']) {
      violations.push('pixi.js is missing from peerDependencies');
    }

    if (!devDependencies['pixi.js']) {
      violations.push(
        'pixi.js is missing from devDependencies — the build needs it locally',
      );
    }

    if (dependencies['vimp-engine']) {
      violations.push(
        'vimp-engine is in dependencies — it belongs in devDependencies',
      );
    }

    if (!devDependencies['vimp-engine']) {
      violations.push('vimp-engine is missing from devDependencies');
    }

    if (name?.startsWith('@') && publishConfig?.access !== 'public') {
      violations.push(
        `scoped package "${name}" needs publishConfig.access: "public"`,
      );
    }

    return verdict(violations);
  },
};
